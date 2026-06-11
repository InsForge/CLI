import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { getProjectConfig, getAccessToken } from '../../lib/config.js';
import {
  handleError,
  getRootOpts,
  CLIError,
  ProjectNotLinkedError,
  AuthError,
} from '../../lib/errors.js';
import { isInteractive } from '../../lib/prompts.js';
import {
  fetchPosthogConnection,
  pollPosthogConnection,
  startPosthogCliFlow,
  type PosthogConnectionResponse,
} from '../../lib/api/posthog.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { trackPosthog, shutdownAnalytics } from '../../lib/analytics.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TRANSIENT_RETRIES = 5;

interface SetupResult {
  /** Whether the dashboard connection already existed (skipped OAuth) or was just established. */
  dashboardConnection: 'already-connected' | 'newly-connected';
  /** Always true — CLI defers SDK install to the user-run `@posthog/wizard`. */
  wizardSkipped: true;
  /** The command the user should run themselves to complete the SDK install. */
  wizardCommand: string;
  /**
   * Details of the connected PostHog project. `apiKey` is PostHog's public
   * client-side key (`phc_…`) — it ships in frontend bundles by design, so
   * printing it is safe and lets the user (or an agent, when the interactive
   * wizard can't run) wire env vars against the exact project the InsForge
   * dashboard reads from.
   */
  connection: {
    apiKey?: string;
    host?: string;
    posthogProjectId?: string | number;
    projectName?: string;
  };
}

// `npx` is installed as `npx.cmd` on Windows.
const NPX_COMMAND = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const WIZARD_COMMAND = `${NPX_COMMAND} -y @posthog/wizard@latest`;

export function registerPosthogSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Connect PostHog to your InsForge dashboard, then run the official PostHog wizard to wire it into your app')
    .option('--skip-browser', 'Do not auto-open the browser for OAuth; only print the URL')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        const result = await runSetup({
          json,
          apiUrl,
          skipBrowser: Boolean(opts.skipBrowser),
        });
        if (json) {
          outputJson({ success: true, ...result });
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}

interface RunSetupOpts {
  json: boolean;
  apiUrl?: string;
  skipBrowser: boolean;
}

// Two-step flow:
//   1. Ensure the InsForge dashboard has a PostHog connection (cli-start /
//      OAuth). This is what populates `posthog_connections` in cloud-backend
//      and makes the in-product Analytics page renderable.
//   2. Print the `npx @posthog/wizard` command and exit. The wizard is
//      interactive (browser OAuth + framework picker) and we always defer it
//      to the user's own terminal — agent shells and CI runners can't drive
//      it, and detecting "are we really attended?" is too fragile.
async function runSetup(opts: RunSetupOpts): Promise<SetupResult> {
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

  trackPosthog('setup', proj);

  if (!opts.json) {
    clack.intro('PostHog setup');
    outputSuccess(`Linked to InsForge project: ${proj.project_name} (${proj.project_id})`);
  }

  // 3. Ensure dashboard connection exists
  const { state: dashboardConnection, connection } = await ensureDashboardConnection(
    proj.project_id,
    token,
    opts,
  );

  // 4. Print the wizard command and exit. The wizard is interactive (browser
  // OAuth + framework picker) and reliably detecting "do we have a real,
  // attended TTY?" is fragile — agent shells allocate a PTY but never type
  // into it; CI runners vary. Rather than try to autodetect, we always defer
  // the wizard step to the user; they paste-and-run one command in their own
  // terminal. CLI's job ends here.
  if (!opts.json) {
    const details = [
      connection.projectName ? `  Project:    ${connection.projectName}` : null,
      connection.posthogProjectId ? `  Project ID: ${connection.posthogProjectId}` : null,
      connection.apiKey ? `  API key:    ${connection.apiKey}` : null,
      connection.host ? `  Host:       ${connection.host}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    clack.note(
      `⚠️  Setup is NOT finished yet. Your app code has no PostHog SDK and no\n` +
        `env vars, so no events will flow until you run the wizard yourself:\n\n` +
        `  ${WIZARD_COMMAND}\n\n` +
        `Run it in your own terminal (it is interactive). It installs the SDK,\n` +
        `writes the PostHog env vars, and adds the init code. When it asks,\n` +
        `pick the PostHog project your InsForge dashboard is connected to:\n\n` +
        `${details}\n\n` +
        `The API key is PostHog's public client-side key, safe to use in\n` +
        `frontend env vars. Once the wizard completes, open the Analytics\n` +
        `page in your InsForge dashboard.`,
      'Next step',
    );
  }

  return {
    dashboardConnection,
    wizardSkipped: true,
    wizardCommand: WIZARD_COMMAND,
    connection: {
      apiKey: connection.apiKey,
      host: connection.host,
      posthogProjectId: connection.posthogProjectId,
      projectName: connection.projectName,
    },
  };
}

// Calls cli-start. If already connected, no-op. Otherwise opens the OAuth
// browser flow and polls until the connection appears. Returns whether we
// hit the fast path or had to wait, plus the connection details (public
// `phc_` key, host, project id) for the wizard handoff note.
async function ensureDashboardConnection(
  projectId: string,
  token: string,
  opts: RunSetupOpts,
): Promise<{
  state: 'already-connected' | 'newly-connected';
  connection: PosthogConnectionResponse;
}> {
  const startResult = await startPosthogCliFlow(projectId, token, opts.apiUrl);

  if (startResult.type === 'connected') {
    if (!opts.json) {
      outputSuccess('PostHog is already connected to your InsForge dashboard.');
    }
    // Sanity-check that cloud-backend has the connection row, surface a clear
    // error if cli-start says yes but /connection says no (data drift).
    const fetchResult = await fetchPosthogConnection(projectId, token, opts.apiUrl);
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
  opts: RunSetupOpts,
): Promise<PosthogConnectionResponse> {
  if (opts.json) {
    // JSON mode: keep stdout clean for the final result object. Print the
    // URL to stderr so a human can copy it if the browser fails to open.
    process.stderr.write(`Authorize PostHog: ${authorizeUrl}\n`);
    process.stderr.write('Your browser should open automatically. If not, copy the URL above.\n');
  } else {
    clack.log.info('PostHog is not yet connected to your InsForge dashboard.');
    if (opts.skipBrowser) {
      clack.log.info(`Open this URL to authorize PostHog:\n${pc.cyan(pc.underline(authorizeUrl))}`);
    } else {
      clack.log.info('Opening browser to authorize PostHog...');
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
    spinner.start('Waiting for InsForge dashboard connection... (timeout: 15 minutes)');
  } else if (!opts.json) {
    // Non-interactive (agent / CI / non-TTY): spinner can't animate, but the
    // user still needs to know we're polling and how long we'll wait.
    clack.log.info('Waiting for InsForge dashboard connection (up to 15 minutes)...');
  }

  try {
    const connection = await pollPosthogConnection(
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
            spinner.message(`Waiting for InsForge dashboard connection... (${remaining})`);
          }
        },
      },
      opts.apiUrl,
    );
    // Always print success — spinner.stop only renders in TTY, but the agent /
    // non-interactive user needs to see the outcome of the wait.
    if (spinner) {
      spinner.stop('InsForge dashboard connection received.');
    } else if (!opts.json) {
      clack.log.success('InsForge dashboard connection received.');
    }
    return connection;
  } catch (err) {
    if (spinner) {
      spinner.stop('InsForge dashboard connection wait failed.');
    } else if (!opts.json) {
      clack.log.error('InsForge dashboard connection wait failed.');
    }
    throw err;
  }
}
