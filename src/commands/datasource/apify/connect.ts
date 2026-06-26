import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { getProjectConfig, getAccessToken } from '../../../lib/config.js';
import {
  handleError,
  getRootOpts,
  CLIError,
  ProjectNotLinkedError,
  AuthError,
} from '../../../lib/errors.js';
import { isInteractive } from '../../../lib/prompts.js';
import {
  fetchApifyConnection,
  pollApifyConnection,
  startApifyCliFlow,
  type ApifyConnectionResponse,
} from '../../../lib/api/apify.js';
import { outputJson, outputSuccess } from '../../../lib/output.js';
import { trackGroupCommand, shutdownAnalytics } from '../../../lib/analytics.js';
import { runApifyAuthBridge } from '../../../lib/apify-bridge.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TRANSIENT_RETRIES = 5;

interface ConnectResult {
  /** Whether the connection already existed (skipped OAuth) or was just established. */
  connectionState: 'already-connected' | 'newly-connected';
  /** Metadata of the connected Apify account (no secrets — the token stays server-side). */
  connection: {
    apifyUsername?: string | null;
    plan?: string | null;
    status?: string;
  };
}

export function registerApifyConnectCommand(program: Command): void {
  program
    .command('connect')
    .description('Connect your Apify account to your InsForge project')
    .option('--skip-browser', 'Do not auto-open the browser for OAuth; only print the URL')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        const result = await runConnect({
          json,
          apiUrl,
          skipBrowser: Boolean(opts.skipBrowser),
        });
        if (json) {
          outputJson({ success: true, ...result });
        }
      } catch (err) {
        // handleError() calls process.exit(), which skips the finally block, so
        // this catch must flush analytics before handing off. The finally below
        // covers the normal (success / json) return path. Both run at most once:
        // on error the finally is skipped (process exits in handleError); on
        // success the catch is skipped. Not a double flush.
        await shutdownAnalytics();
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}

interface RunConnectOpts {
  json: boolean;
  apiUrl?: string;
  skipBrowser: boolean;
}

// Ensures the InsForge project has an Apify connection (cli-start / OAuth).
// This populates the connection in cloud-backend and makes the in-product
// data-source integration usable. Unlike PostHog there is no SDK-install
// wizard step — the command ends once connected.
async function runConnect(opts: RunConnectOpts): Promise<ConnectResult> {
  // 1. Linked project
  const proj = getProjectConfig();
  if (!proj || !proj.project_id) {
    throw new ProjectNotLinkedError();
  }

  // 2. Login token
  const token = getAccessToken();
  if (!token) {
    throw new AuthError('Not logged in. Run `insforge login` first.');
  }

  trackGroupCommand('apify', 'connect', proj);

  if (!opts.json) {
    clack.intro('Apify connect');
    outputSuccess(`Linked to InsForge project: ${proj.project_name} (${proj.project_id})`);
  }

  // 3. Ensure connection exists
  const { state: connectionState, connection } = await ensureConnection(
    proj.project_id,
    token,
    opts,
  );

  // Auth bridge: log in the local Apify CLI + install skills so the agent is
  // immediately usable — no manual `apify login` browser flow required.
  // Gracefully degraded: a failure here never blocks the connect result.
  try {
    const { skillsInstalled } = await runApifyAuthBridge(opts.json);
    if (!opts.json && !skillsInstalled) {
      clack.log.warn(
        'Agent skills did not install. Re-run `insforge datasource apify login`, or install manually with `npx skills add apify/agent-skills`.',
      );
    }
  } catch {
    if (!opts.json) {
      clack.log.warn(
        'Connected, but auto-login/skills install failed. Run `insforge datasource apify login` to finish.',
      );
    }
  }

  if (!opts.json) {
    const details = [
      connection.apifyUsername ? `  Account:  ${connection.apifyUsername}` : null,
      connection.plan ? `  Plan:     ${connection.plan}` : null,
      connection.status ? `  Status:   ${connection.status}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    clack.outro(
      details
        ? `Apify is connected to your InsForge project.\n\n${details}`
        : 'Apify is connected to your InsForge project.',
    );
  }

  return {
    connectionState,
    connection: {
      apifyUsername: connection.apifyUsername,
      plan: connection.plan,
      status: connection.status,
    },
  };
}

// Calls cli-start. If already connected, no-op. Otherwise opens the OAuth
// browser flow and polls until the connection appears. Returns whether we
// hit the fast path or had to wait, plus the connection metadata.
async function ensureConnection(
  projectId: string,
  token: string,
  opts: RunConnectOpts,
): Promise<{
  state: 'already-connected' | 'newly-connected';
  connection: ApifyConnectionResponse;
}> {
  const startResult = await startApifyCliFlow(projectId, token, opts.apiUrl);

  if (startResult.type === 'connected') {
    if (!opts.json) {
      outputSuccess('Apify is already connected to your InsForge project.');
    }
    // Sanity-check that cloud-backend has the connection row, surface a clear
    // error if cli-start says yes but /connection says no (data drift).
    const fetchResult = await fetchApifyConnection(projectId, token, opts.apiUrl);
    if (fetchResult.kind === 'forbidden') {
      throw new CLIError(`Forbidden: ${fetchResult.message}`, 5);
    }
    if (fetchResult.kind === 'unauthorized') {
      throw new AuthError(`Not authenticated: ${fetchResult.message}. Re-run \`insforge login\`.`);
    }
    if (fetchResult.kind === 'error') {
      throw new CLIError(`Could not verify the Apify connection: ${fetchResult.message}`);
    }
    if (fetchResult.kind !== 'connected') {
      throw new CLIError(
        'cli-start reported connected, but /connection returned not-connected. Try again, or check the dashboard.',
      );
    }
    return { state: 'already-connected', connection: fetchResult.connection };
  }

  const connection = await runConnectFlow(projectId, token, startResult.authorizeUrl, opts);
  return { state: 'newly-connected', connection };
}

async function runConnectFlow(
  projectId: string,
  token: string,
  authorizeUrl: string,
  opts: RunConnectOpts,
): Promise<ApifyConnectionResponse> {
  if (opts.json) {
    // JSON mode: keep stdout clean for the final result object. Print the
    // URL to stderr so a human can copy it if the browser fails to open.
    process.stderr.write(`Authorize Apify: ${authorizeUrl}\n`);
    process.stderr.write('Your browser should open automatically. If not, copy the URL above.\n');
  } else {
    clack.log.info('Apify is not yet connected to your InsForge project.');
    if (opts.skipBrowser) {
      clack.log.info(`Open this URL to authorize Apify:\n${pc.cyan(pc.underline(authorizeUrl))}`);
    } else {
      clack.log.info('Opening browser to authorize Apify...');
      clack.log.info(`If browser doesn't open, visit:\n${pc.cyan(pc.underline(authorizeUrl))}`);
    }
  }

  if (!opts.skipBrowser) {
    try {
      const open = (await import('open')).default;
      await open(authorizeUrl);
    } catch {
      // Best-effort — URL was already printed above.
    }
  }

  const spinner = !opts.json && isInteractive ? clack.spinner() : null;
  if (spinner) {
    spinner.start('Waiting for Apify connection... (timeout: 15 minutes)');
  } else if (!opts.json) {
    // Non-interactive (agent / CI / non-TTY): spinner can't animate, but the
    // user still needs to know we're polling and how long we'll wait.
    clack.log.info('Waiting for Apify connection (up to 15 minutes)...');
  }

  try {
    const connection = await pollApifyConnection(
      projectId,
      token,
      {
        intervalMs: POLL_INTERVAL_MS,
        timeoutMs: POLL_TIMEOUT_MS,
        maxTransientRetries: MAX_TRANSIENT_RETRIES,
        onTick: (elapsed): void => {
          if (spinner) {
            const secs = Math.floor(elapsed / 1000);
            const mins = Math.floor(secs / 60);
            const remaining = `${mins}m ${secs % 60}s elapsed`;
            spinner.message(`Waiting for Apify connection... (${remaining})`);
          }
        },
      },
      opts.apiUrl,
    );
    // Always print success — spinner.stop only renders in TTY, but the agent /
    // non-interactive user needs to see the outcome of the wait.
    if (spinner) {
      spinner.stop('Apify connection received.');
    } else if (!opts.json) {
      clack.log.success('Apify connection received.');
    }
    return connection;
  } catch (err) {
    if (spinner) {
      spinner.stop('Apify connection wait failed.');
    } else if (!opts.json) {
      clack.log.error('Apify connection wait failed.');
    }
    throw err;
  }
}
