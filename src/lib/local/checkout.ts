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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIError } from '../errors.js';
import { ensureLocalDir, OVERLAYS } from './state.js';

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

/**
 * Every file the compose file mounts or reads, relative to the checkout.
 *
 * Mirrors setup.sh's own list. Checking only the compose file and .env let an
 * interrupted fetch pass as ready, and the start then failed inside Compose on
 * a missing mount instead of here with something to act on.
 */
const REQUIRED_FILES = [
  '.env',
  'deploy/docker-compose/docker-compose.yml',
  // Both are mounted into /docker-entrypoint-initdb.d. A bind mount whose source
  // is absent does not fail — Docker creates a directory there, and Postgres init
  // then chokes on it, which reads as nothing to do with a missing file.
  'deploy/docker-init/db/db-init.sql',
  'deploy/docker-init/db/jwt.sql',
  'deploy/docker-init/db/postgresql.conf',
  'functions/server.ts',
  'functions/deno.json',
  // Named in the deno command line's --allow-read, so its absence surfaces when
  // a function is invoked rather than at boot.
  'functions/worker-template.js',
];

/**
 * Files a start needs that are not there. Empty means the checkout is usable.
 *
 * The storage overlay comes from compose.ts's own map rather than a copy here:
 * two lists would let validation and the compose invocation disagree about
 * which file has to exist.
 *
 * A regular file, not merely a path that exists. A failed start leaves
 * directories behind at bind-mount sources — that is what a missing jwt.sql
 * turns into — and existsSync then reports the broken checkout as ready.
 */
export function missingCheckoutFiles(cwd?: string, storage?: string): string[] {
  const wanted = [...REQUIRED_FILES];
  const overlay =
    storage && storage !== 'local' ? OVERLAYS[storage as keyof typeof OVERLAYS] : undefined;
  if (overlay) wanted.push(overlay);
  return wanted.filter((f) => {
    try {
      return !statSync(join(checkoutDir(cwd), f)).isFile();
    } catch {
      return true;
    }
  });
}

/** True once the checkout holds what a start needs. */
export function checkoutReady(cwd?: string, storage?: string): boolean {
  return missingCheckoutFiles(cwd, storage).length === 0;
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
export async function ensureCheckout(
  cwd?: string,
  onExistingData?: () => string[],
  storage?: string,
): Promise<string> {
  const dir = checkoutDir(cwd);
  let script: string;
  try {
    script = await fetchSetupScript();
  } catch (err) {
    if (checkoutReady(cwd, storage)) return dir;
    throw new CLIError(
      `Could not fetch InsForge's setup script: ${err instanceof Error ? err.message : String(err)}\n` +
        `  ${SETUP_URL}\n\n` +
        'The stack is defined in that repository rather than bundled with the CLI,\n' +
        'so a first start needs to reach it. Later starts reuse what it wrote.',
    );
  }

  mkdirSync(dir, { recursive: true });
  // setup.sh generates a fresh set of secrets whenever .env is absent, and the
  // Postgres password it picks is only read when a cluster is created. Against
  // volumes that already exist, the new password never reaches the database and
  // the backend cannot log in to its own data — recoverable only by restoring
  // the file. Refuse instead, before anything is written.
  if (!existsSync(checkoutEnvFile(cwd)) && onExistingData) {
    const kept = onExistingData();
    if (kept.length > 0) {
      throw new CLIError(
        `This directory has data from a previous instance (${kept.length} volume` +
          `${kept.length === 1 ? '' : 's'}) but ${checkoutEnvFile(cwd)} is gone.\n\n` +
          'That file holds the only copy of its secrets. Generating new ones would\n' +
          'leave the database unreachable behind the old password.\n\n' +
          '  • Restore the file from a backup and start again, or\n' +
          '  • `insforge local stop --delete-data` to discard the old instance.',
      );
    }
  }
  const scriptPath = join(dir, '..', 'setup.sh');
  writeFileSync(scriptPath, script, { mode: 0o700 });

  const run = spawnSync('sh', [scriptPath, dir], {
    encoding: 'utf-8',
    env: { ...process.env, INSFORGE_NO_GIT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.error && (run.error as NodeJS.ErrnoException).code === 'ENOENT') {
    // Plain Windows has no `sh`. Docker Desktop there runs on WSL2 anyway, so
    // the shell is one terminal away rather than a missing dependency.
    throw new CLIError(
      'No `sh` on PATH, so InsForge\'s setup script cannot run.\n\n' +
        'On Windows, run `insforge local start` from WSL or Git Bash.',
    );
  }
  if (run.status !== 0) {
    throw new CLIError(
      'InsForge\'s setup script failed.\n' +
        (run.stderr?.trim() || run.stdout?.trim() || '(no output)'),
    );
  }
  const missing = missingCheckoutFiles(cwd, storage);
  if (missing.length > 0) {
    throw new CLIError(
      `The setup script reported success but ${dir} is missing:\n` +
        missing.map((f) => `  • ${f}`).join('\n'),
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
