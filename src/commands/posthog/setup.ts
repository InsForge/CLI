import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { getProjectConfig, getAccessToken, getFrontendUrl } from '../../lib/config.js';
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
  fetchPosthogCliCredentials,
  type PosthogConnectionResponse,
  type PosthogCliCredentials,
} from '../../lib/api/posthog.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TRANSIENT_RETRIES = 5;

interface SetupResult {
  wizardExitCode: number | null;
}

export function registerPosthogSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Install the PostHog SDK into the current directory app')
    .option('--skip-browser', 'Do not auto-open the browser; only print the URL')
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
      }
    });
}

interface RunSetupOpts {
  json: boolean;
  apiUrl?: string;
  skipBrowser: boolean;
}

async function runSetup(opts: RunSetupOpts): Promise<SetupResult> {
  // 1. Linked project
  const proj = getProjectConfig();
  if (!proj || !proj.project_id) {
    throw new ProjectNotLinkedError();
  }

  // 2. Login token (raw access — fetchPosthogConnection takes the JWT directly
  // because cloud-backend's connection endpoint uses user-Bearer auth, not the
  // refresh-on-401 path. Re-running `insforge login` is the recovery; we don't
  // need to plumb refresh here.)
  const token = getAccessToken();
  if (!token) {
    throw new AuthError('Not logged in. Run `insforge login` first.');
  }

  if (!opts.json) {
    clack.intro('PostHog setup');
    outputSuccess(`Linked to InsForge project: ${proj.project_name} (${proj.project_id})`);
  }

  // 3. Fetch existing connection
  let conn = await fetchExistingConnection(proj.project_id, token, opts);

  // 4. If no connection, prompt browser flow + poll
  if (!conn) {
    conn = await runConnectFlow(proj.project_id, token, opts);
  }

  if (!conn.apiKey) {
    // Defensive: pollPosthogConnection should have guaranteed a phc_ key,
    // but cloud-backend could conceivably 200 with a partial body.
    throw new CLIError('Connection succeeded but cloud-backend returned no apiKey. Try again or check the dashboard.');
  }

  // 5. Fetch CLI credentials (includes phx_ — sensitive, used for wizard --ci)
  const creds = await fetchPosthogCliCredentials(proj.project_id, token, opts.apiUrl);

  // 6. Spawn `npx -y @posthog/wizard@latest --ci` with credentials. Wizard
  // auto-detects framework from the user's package.json — we don't.
  const exitCode = await spawnWizard(creds, opts);

  if (!opts.json) {
    if (exitCode === 0) {
      clack.outro('Done. Run your dev server to start sending events.');
    } else {
      clack.outro(pc.yellow(`Wizard exited with code ${exitCode}. See output above for details.`));
    }
  }

  return { wizardExitCode: exitCode };
}

async function spawnWizard(
  creds: PosthogCliCredentials,
  opts: RunSetupOpts,
): Promise<number | null> {
  const args = [
    '-y',
    '@posthog/wizard@latest',
    '--ci',
    '--api-key', creds.personalApiKey,
    '--project-id', String(creds.posthogProjectId),
    '--region', creds.region.toLowerCase(),
    '--install-dir', '.',
  ];

  if (!opts.json) {
    outputInfo('Running PostHog wizard to install the SDK...');
  }

  return await new Promise<number | null>((resolve, reject) => {
    const child = spawn('npx', args, {
      cwd: process.cwd(),
      stdio: opts.json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: process.env,
    });
    child.on('error', err => reject(new CLIError(`Failed to launch wizard: ${err.message}`)));
    child.on('exit', code => resolve(code));
  });
}

async function fetchExistingConnection(
  projectId: string,
  token: string,
  opts: RunSetupOpts,
): Promise<PosthogConnectionResponse | null> {
  const result = await fetchPosthogConnection(projectId, token, opts.apiUrl);
  switch (result.kind) {
    case 'connected':
      if (!opts.json) outputSuccess('PostHog already connected to this project.');
      return result.connection;
    case 'not-connected':
      return null;
    case 'forbidden':
      throw new CLIError(`Forbidden: ${result.message}`, 5);
    case 'error':
      throw new CLIError(`Could not check PostHog connection: ${result.message}`);
  }
}

async function runConnectFlow(
  projectId: string,
  token: string,
  opts: RunSetupOpts,
): Promise<PosthogConnectionResponse> {
  // `action=connect` triggers the cloud-shell auto-trigger (fires OAuth start
  // and redirects to PostHog before the iframe matters). `route=/dashboard/analytics`
  // is a fallback so that if auto-trigger fails for any reason, the iframe at
  // least lands on the Analytics page where the Connect PostHog button is visible.
  const url = `${getFrontendUrl()}/dashboard/project/${projectId}?action=connect&route=${encodeURIComponent('/dashboard/analytics')}`;

  if (!opts.json) {
    clack.log.info('PostHog is not connected to this project yet.');
    outputInfo('');
    outputInfo(`Open this URL to authorize PostHog:\n  ${pc.cyan(pc.underline(url))}`);
    outputInfo('');
  }

  if (!opts.skipBrowser) {
    try {
      const open = (await import('open')).default;
      await open(url);
    } catch {
      // Best-effort — URL was already printed above.
    }
  }

  const spinner = !opts.json && isInteractive ? clack.spinner() : null;
  spinner?.start('Waiting for connection... (timeout: 15 minutes)');

  try {
    const conn = await pollPosthogConnection(
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
            spinner.message(`Waiting for connection... (${remaining})`);
          }
        },
      },
      opts.apiUrl,
    );
    spinner?.stop('Connection received from PostHog.');
    return conn;
  } catch (err) {
    spinner?.stop('Connection wait failed.');
    throw err;
  }
}

