/**
 * Fetch and run InsForge's own setup.sh to populate `.insforge/checkout/`.
 *
 * The CLI used to carry a 266-line copy of the compose file plus the four files
 * it inlines. That copy drifted within a day of being written — the connection
 * pool alignment added upstream never reached it. So the stack definition comes
 * from the repository now, through the script the repository already ships for
 * exactly this: it owns the file list, the layout the compose file's relative
 * mounts expect, and the secret generation.
 *
 * INSFORGE_NO_GIT=1 keeps `docker` the only thing a developer needs installed;
 * the script falls back to fetching each file over HTTPS.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIError } from '../errors.js';
import { ensureLocalDir } from './state.js';

const SETUP_URL = 'https://raw.githubusercontent.com/InsForge/InsForge/main/deploy/setup.sh';
const FETCH_TIMEOUT_MS = 15_000;

/** Where the stack's files live. One directory, updated in place: the secrets
 *  sit beside them and have to survive a version change. */
export function checkoutDir(cwd?: string): string {
  return join(ensureLocalDir(cwd), 'checkout');
}

/** The compose file the CLI runs — upstream's, unmodified. */
export function upstreamComposeFile(cwd?: string): string {
  return join(checkoutDir(cwd), 'deploy', 'docker-compose', 'docker-compose.yml');
}

/** The env file setup.sh generates, holding the secrets it made. */
export function checkoutEnvFile(cwd?: string): string {
  return join(checkoutDir(cwd), '.env');
}

/** True once the checkout holds what a start needs. */
export function checkoutReady(cwd?: string): boolean {
  return existsSync(upstreamComposeFile(cwd)) && existsSync(checkoutEnvFile(cwd));
}

async function fetchSetupScript(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SETUP_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = await res.text();
    if (!body.includes('INSFORGE_NO_GIT')) {
      // Not the script we expect — a proxy login page, or a release predating
      // the flag. Running it would clone with git, or do something else again.
      throw new Error('response is not a setup.sh that supports INSFORGE_NO_GIT');
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make sure `.insforge/checkout/` holds the stack, and return its directory.
 *
 * Re-running is how a stale checkout catches up, so this fetches every time
 * rather than short-circuiting on an existing directory: setup.sh overwrites the
 * files it owns and leaves `.env` alone, which is the behaviour to inherit.
 * Offline with a checkout already in place is the one case that skips the fetch.
 */
export async function ensureCheckout(cwd?: string): Promise<string> {
  const dir = checkoutDir(cwd);
  let script: string;
  try {
    script = await fetchSetupScript();
  } catch (err) {
    if (checkoutReady(cwd)) return dir;
    throw new CLIError(
      `Could not fetch InsForge's setup script: ${err instanceof Error ? err.message : String(err)}\n` +
        `  ${SETUP_URL}\n\n` +
        'The stack is defined in that repository rather than bundled with the CLI,\n' +
        'so a first start needs to reach it. Later starts reuse what it wrote.',
    );
  }

  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, '..', 'setup.sh');
  writeFileSync(scriptPath, script, { mode: 0o700 });

  const run = spawnSync('sh', [scriptPath, dir], {
    encoding: 'utf-8',
    env: { ...process.env, INSFORGE_NO_GIT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.status !== 0) {
    throw new CLIError(
      'InsForge\'s setup script failed.\n' +
        (run.stderr?.trim() || run.stdout?.trim() || '(no output)'),
    );
  }
  if (!checkoutReady(cwd)) {
    throw new CLIError(
      `The setup script reported success but ${dir} has no compose file or .env.`,
    );
  }
  return dir;
}

/** Read the env file setup.sh generated into a map. */
export function readCheckoutEnv(cwd?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const path = checkoutEnvFile(cwd);
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
