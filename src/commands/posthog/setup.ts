import type { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
  type PosthogConnectionResponse,
} from '../../lib/api/posthog.js';
import {
  contextFromCwd,
  detectFramework,
  type Framework,
} from '../../lib/framework-detect.js';
import {
  detectPackageManager,
  hasPackage,
  installCommand,
  runInstall,
  type PackageManager,
} from '../../lib/package-manager.js';
import { upsertEnvFile } from '../../lib/env-writer.js';
import { templates, renderTemplate } from '../../templates/posthog/index.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_TRANSIENT_RETRIES = 5;

interface SetupResult {
  framework: Framework | 'astro' | null;
  installedSdk: boolean;
  filesWritten: string[];
  envWritten: { file: string; added: string[]; mismatched: string[] };
  notes: string[];
}

export function registerPosthogSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Install the PostHog SDK into the current directory app')
    .option('--framework <name>', 'Force framework (next-app|next-pages|vite-react|sveltekit|astro)')
    .option('--skip-install', 'Do not run the package manager install step')
    .option('--skip-browser', 'Do not auto-open the browser; only print the URL')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        const result = await runSetup({
          json,
          apiUrl,
          forceFramework: opts.framework as string | undefined,
          skipInstall: Boolean(opts.skipInstall),
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
  forceFramework?: string;
  skipInstall: boolean;
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
    // but cloud-backend could conceivably 200 with a partial body. Surface
    // a clear error rather than writing `undefined` into the user's env file.
    throw new CLIError('Connection succeeded but cloud-backend returned no apiKey. Try again or check the dashboard.');
  }

  // 5. Detect framework
  const framework = resolveFramework(opts);
  if (framework === null) {
    return reportNoFramework(conn, opts);
  }

  if (framework === 'astro') {
    return reportAstroFallback(conn, opts);
  }

  if (!opts.json) outputSuccess(`Detected framework: ${frameworkLabel(framework)}`);

  // 6. Install SDK
  const cwd = process.cwd();
  const ctx = contextFromCwd(cwd);
  const pm = detectPackageManager(cwd);
  const alreadyInstalled = hasPackage(ctx.pkg, 'posthog-js');
  let installedSdk = false;

  if (alreadyInstalled) {
    if (!opts.json) outputInfo(pc.dim('posthog-js is already installed — skipping install.'));
  } else if (opts.skipInstall) {
    if (!opts.json) {
      outputInfo(pc.yellow(`Skipping install. Run manually: ${installCommand(pm, 'posthog-js')}`));
    }
  } else {
    installedSdk = await installSdk(pm, cwd, opts);
  }

  // 7. Write init code + env
  const filesWritten: string[] = [];
  const notes: string[] = [];
  const envResult = writeForFramework(framework, conn, cwd, filesWritten, notes, opts);

  if (!opts.json) {
    if (notes.length > 0) {
      for (const n of notes) clack.log.info(n);
    }
    clack.outro('Done. Run your dev server to start sending events.');
  }

  return {
    framework,
    installedSdk,
    filesWritten,
    envWritten: envResult,
    notes,
  };
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
  const url = `${getFrontendUrl()}/dashboard/${projectId}/analytics?action=connect`;

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

function resolveFramework(opts: RunSetupOpts): Framework | 'astro' | null {
  if (opts.forceFramework) {
    const valid: Array<Framework | 'astro'> = [
      'next-app',
      'next-pages',
      'vite-react',
      'sveltekit',
      'astro',
    ];
    if (!valid.includes(opts.forceFramework as Framework | 'astro')) {
      throw new CLIError(
        `Invalid --framework "${opts.forceFramework}". Valid: ${valid.join(', ')}`,
      );
    }
    return opts.forceFramework as Framework | 'astro';
  }

  return detectFramework(contextFromCwd(process.cwd()));
}

async function installSdk(
  pm: PackageManager,
  cwd: string,
  opts: RunSetupOpts,
): Promise<boolean> {
  const cmd = installCommand(pm, 'posthog-js');
  const spinner = !opts.json && isInteractive ? clack.spinner() : null;
  spinner?.start(`Installing posthog-js (${cmd})...`);
  try {
    await runInstall(pm, 'posthog-js', cwd);
    spinner?.stop('Installed posthog-js.');
    return true;
  } catch (err) {
    spinner?.stop('Install failed.');
    if (!opts.json) {
      clack.log.warn(
        `Could not run \`${cmd}\` automatically: ${(err as Error).message}\nRun it manually, then re-run \`insforge posthog setup\`.`,
      );
    }
    return false;
  }
}

function writeForFramework(
  framework: Framework,
  conn: PosthogConnectionResponse,
  cwd: string,
  filesWritten: string[],
  notes: string[],
  opts: RunSetupOpts,
): { file: string; added: string[]; mismatched: string[] } {
  const host = conn.host || 'https://us.posthog.com';
  const phc = conn.apiKey ?? '';

  switch (framework) {
    case 'next-app':
      return writeNextApp(cwd, phc, host, filesWritten, notes, opts);
    case 'next-pages':
      return writeNextPages(cwd, phc, host, filesWritten, notes, opts);
    case 'vite-react':
      return writeViteReact(cwd, phc, host, filesWritten, notes, opts);
    case 'sveltekit':
      return writeSveltekit(cwd, phc, host, filesWritten, notes, opts);
  }
}

function writeNextApp(
  cwd: string,
  phc: string,
  host: string,
  filesWritten: string[],
  notes: string[],
  opts: RunSetupOpts,
): { file: string; added: string[]; mismatched: string[] } {
  const appDir = existsSync(join(cwd, 'src/app')) ? 'src/app' : 'app';
  const providerPath = join(cwd, appDir, 'posthog-provider.tsx');
  writeIfMissing(
    providerPath,
    renderTemplate(templates['next-app'].provider, { HOST: host }),
    filesWritten,
    notes,
    opts,
  );

  // Layout snippet — emit as a printable note rather than auto-modifying
  // app/layout.tsx (too much variance in user layout files to rewrite safely).
  notes.push(
    `Add the provider to your ${appDir}/layout.tsx:\n${templates['next-app'].layoutSnippet}`,
  );

  const envFile = '.env.local';
  return writeEnv(cwd, envFile, {
    NEXT_PUBLIC_POSTHOG_KEY: phc,
    NEXT_PUBLIC_POSTHOG_HOST: host,
  }, opts);
}

function writeNextPages(
  cwd: string,
  phc: string,
  host: string,
  filesWritten: string[],
  notes: string[],
  opts: RunSetupOpts,
): { file: string; added: string[]; mismatched: string[] } {
  const pagesDir = existsSync(join(cwd, 'src/pages')) ? 'src/pages' : 'pages';
  const appPath = join(cwd, pagesDir, '_app.tsx');
  writeIfMissing(
    appPath,
    renderTemplate(templates['next-pages'].app, { HOST: host }),
    filesWritten,
    notes,
    opts,
    'pages/_app.tsx already exists. Open it and add `posthog.init(...)` near the top — see PostHog Next.js docs.',
  );

  const envFile = '.env.local';
  return writeEnv(cwd, envFile, {
    NEXT_PUBLIC_POSTHOG_KEY: phc,
    NEXT_PUBLIC_POSTHOG_HOST: host,
  }, opts);
}

function writeViteReact(
  cwd: string,
  phc: string,
  host: string,
  _filesWritten: string[],
  notes: string[],
  opts: RunSetupOpts,
): { file: string; added: string[]; mismatched: string[] } {
  // Vite users almost always already have src/main.tsx. We don't auto-edit
  // it (too varied — some users have providers, custom roots, etc.); emit
  // a snippet they can paste in.
  notes.push(
    `Add this snippet near the top of src/main.tsx:\n${renderTemplate(templates['vite-react'].mainSnippet, { HOST: host })}`,
  );

  const envFile = '.env';
  return writeEnv(cwd, envFile, {
    VITE_PUBLIC_POSTHOG_KEY: phc,
    VITE_PUBLIC_POSTHOG_HOST: host,
  }, opts);
}

function writeSveltekit(
  cwd: string,
  phc: string,
  host: string,
  filesWritten: string[],
  notes: string[],
  opts: RunSetupOpts,
): { file: string; added: string[]; mismatched: string[] } {
  const hooksPath = join(cwd, 'src/hooks.client.ts');
  writeIfMissing(
    hooksPath,
    renderTemplate(templates.sveltekit.hooks, { HOST: host }),
    filesWritten,
    notes,
    opts,
    'src/hooks.client.ts already exists. Add `posthog.init(...)` to it — see PostHog SvelteKit docs.',
  );

  const envFile = '.env';
  return writeEnv(cwd, envFile, {
    PUBLIC_POSTHOG_KEY: phc,
    PUBLIC_POSTHOG_HOST: host,
  }, opts);
}

function writeIfMissing(
  filePath: string,
  contents: string,
  filesWritten: string[],
  notes: string[],
  opts: RunSetupOpts,
  conflictNote?: string,
): void {
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    if (existing.includes('posthog.init')) {
      if (!opts.json) {
        outputInfo(pc.dim(`${relative(filePath)} already calls posthog.init — leaving it alone.`));
      }
      return;
    }
    if (conflictNote) notes.push(conflictNote);
    if (!opts.json) {
      outputInfo(
        pc.yellow(`${relative(filePath)} exists. Skipped writing — see notes below for manual changes.`),
      );
    }
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  filesWritten.push(filePath);
  if (!opts.json) outputSuccess(`Wrote ${relative(filePath)}`);
}

function writeEnv(
  cwd: string,
  envFile: string,
  entries: Record<string, string>,
  opts: RunSetupOpts,
): { file: string; added: string[]; mismatched: string[] } {
  const path = join(cwd, envFile);
  const r = upsertEnvFile(path, entries);

  if (!opts.json) {
    if (r.added.length > 0) {
      outputSuccess(`Wrote ${envFile}: ${r.added.join(', ')}`);
    }
    if (r.skipped.length > 0) {
      outputInfo(pc.dim(`${envFile}: ${r.skipped.join(', ')} already set (matching) — left as-is.`));
    }
    for (const m of r.mismatched) {
      clack.log.warn(
        `${envFile} has ${m.key}=${pc.dim(m.existingValue)}, expected ${m.newValue}. Left existing value untouched.`,
      );
    }
  }

  return {
    file: envFile,
    added: r.added,
    mismatched: r.mismatched.map((m) => m.key),
  };
}

function reportNoFramework(
  conn: PosthogConnectionResponse,
  opts: RunSetupOpts,
): SetupResult {
  if (!opts.json) {
    clack.log.warn('No supported framework detected in this directory.');
    outputInfo('');
    outputInfo(`Your PostHog public key:  ${pc.cyan(conn.apiKey ?? '(missing)')}`);
    outputInfo(`Your PostHog host:        ${conn.host ?? 'https://us.posthog.com'}`);
    outputInfo('');
    outputInfo('See https://posthog.com/docs/libraries to install the SDK manually.');
    clack.outro('Done.');
  }
  return {
    framework: null,
    installedSdk: false,
    filesWritten: [],
    envWritten: { file: '', added: [], mismatched: [] },
    notes: ['No supported framework detected.'],
  };
}

function reportAstroFallback(
  conn: PosthogConnectionResponse,
  opts: RunSetupOpts,
): SetupResult {
  if (!opts.json) {
    clack.log.info('Detected Astro. Auto-install for Astro is not supported in v1.');
    outputInfo('');
    outputInfo(`Your PostHog public key:  ${pc.cyan(conn.apiKey ?? '(missing)')}`);
    outputInfo(`Your PostHog host:        ${conn.host ?? 'https://us.posthog.com'}`);
    outputInfo('');
    outputInfo('Follow https://posthog.com/docs/libraries/astro to install.');
    clack.outro('Done.');
  }
  return {
    framework: 'astro',
    installedSdk: false,
    filesWritten: [],
    envWritten: { file: '', added: [], mismatched: [] },
    notes: ['Astro fallback — see PostHog docs.'],
  };
}

function frameworkLabel(framework: Framework): string {
  switch (framework) {
    case 'next-app':
      return 'Next.js (App Router)';
    case 'next-pages':
      return 'Next.js (Pages Router)';
    case 'vite-react':
      return 'Vite + React';
    case 'sveltekit':
      return 'SvelteKit';
  }
}

function relative(p: string): string {
  return p.replace(process.cwd() + '/', '');
}
