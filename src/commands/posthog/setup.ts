import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
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
} from '../../lib/api/posthog.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TRANSIENT_RETRIES = 5;

interface SetupResult {
  /** Whether the dashboard connection already existed (skipped OAuth) or was just established. */
  dashboardConnection: 'already-connected' | 'newly-connected';
  /** True when JSON mode skipped the wizard step (wizard is interactive and incompatible with piped stdio). */
  wizardSkipped: boolean;
  /** Wizard process exit code; only set when wizardSkipped is false. */
  wizardExitCode?: number;
  /** Command the caller should run to complete the wizard step; only set when wizardSkipped is true. */
  wizardCommand?: string;
}

// `npx` is installed as `npx.cmd` on Windows; passing the bare name to spawn
// without a shell results in ENOENT. Use the platform-specific binary.
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
//   2. Spawn `npx @posthog/wizard` — it runs its own OAuth, lets the user pick
//      a PostHog project, and installs + wires up the SDK in the app code.
//
// The two OAuths are independent and may even land on different PostHog
// projects (rare in practice — same user account usually means same project).
// We don't pass anything to the wizard; per its docs it discovers the project
// interactively.
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

  if (!opts.json) {
    clack.intro('PostHog setup');
    outputSuccess(`Linked to InsForge project: ${proj.project_name} (${proj.project_id})`);
  }

  // 3. Ensure dashboard connection exists
  const dashboardConnection = await ensureDashboardConnection(proj.project_id, token, opts);

  // 4. Run the official PostHog wizard for app-code wiring.
  //
  // JSON mode is for scripted / headless callers, but the wizard is interactive
  // (terminal TUI for framework + project selection, browser OAuth). Skip it
  // and surface the command so the caller can run it themselves under a real
  // TTY; piping its stdio would either hang or swallow the prompts.
  if (opts.json) {
    return {
      dashboardConnection,
      wizardSkipped: true,
      wizardCommand: WIZARD_COMMAND,
    };
  }

  outputInfo('Running the official PostHog setup wizard to wire PostHog into your app...');
  outputInfo(
    pc.dim('(it will open a browser for OAuth and let you pick a PostHog project)'),
  );

  const wizardResult = spawnSync(NPX_COMMAND, ['-y', '@posthog/wizard@latest'], {
    stdio: 'inherit',
    env: process.env,
  });

  if (wizardResult.error) {
    throw new CLIError(`Failed to launch PostHog wizard: ${wizardResult.error.message}`);
  }
  const exitCode = wizardResult.status ?? 1;
  // Treat user-initiated cancellation (Ctrl+C → 130 / SIGINT) as a clean exit
  // rather than an error; the user just chose to abort the wizard step.
  if (wizardResult.signal === 'SIGINT' || exitCode === 130) {
    clack.outro('Setup cancelled.');
    return {
      dashboardConnection,
      wizardSkipped: false,
      wizardExitCode: exitCode,
    };
  }
  if (exitCode !== 0) {
    throw new CLIError(`PostHog wizard exited with code ${exitCode}.`);
  }

  clack.outro('Done. Open the Analytics page in your InsForge dashboard to view data.');

  return {
    dashboardConnection,
    wizardSkipped: false,
    wizardExitCode: exitCode,
  };
}

// Calls cli-start. If already connected, no-op. Otherwise opens the OAuth
// browser flow and polls until the connection appears. Returns whether we
// hit the fast path or had to wait.
async function ensureDashboardConnection(
  projectId: string,
  token: string,
  opts: RunSetupOpts,
): Promise<'already-connected' | 'newly-connected'> {
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
    return 'already-connected';
  }

  await runConnectFlow(projectId, token, startResult.authorizeUrl, opts);
  return 'newly-connected';
}

async function runConnectFlow(
  projectId: string,
  token: string,
  authorizeUrl: string,
  opts: RunSetupOpts,
): Promise<void> {
  if (opts.json) {
    // JSON mode: keep stdout clean for the final result object. Print the
    // URL to stderr so a human can copy it if the browser fails to open.
    process.stderr.write(`Authorize PostHog: ${authorizeUrl}\n`);
    process.stderr.write('Your browser should open automatically. If not, copy the URL above.\n');
  } else {
    clack.log.info('PostHog is not yet connected to your InsForge dashboard.');
    outputInfo('');
    outputInfo(`Open this URL to authorize PostHog:\n  ${pc.cyan(pc.underline(authorizeUrl))}`);
    outputInfo('');
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
  spinner?.start('Waiting for InsForge dashboard connection... (timeout: 15 minutes)');

  try {
    await pollPosthogConnection(
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
    spinner?.stop('InsForge dashboard connection received.');
  } catch (err) {
    spinner?.stop('InsForge dashboard connection wait failed.');
    throw err;
  }
}
