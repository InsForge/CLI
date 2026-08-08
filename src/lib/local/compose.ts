/**
 * Thin wrapper around `docker compose` for local instances.
 *
 * The compose file is InsForge's own, fetched into `.insforge/checkout/` by its
 * setup.sh (see checkout.ts) and run unmodified. The CLI adds one overlay, for
 * the telemetry stamp, and supplies ports and keys through `--env-file`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIError } from '../errors.js';
import { checkoutDir, checkoutEnvFile, upstreamComposeFile } from './checkout.js';
import type { StorageBackend } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLI_OVERLAY = 'cli-overlay.yml';

/**
 * Locate the CLI's own asset directory. `dist/index.js` resolves to
 * `dist/assets/local/`; running from source (tsx src/index.ts) resolves to
 * `src/assets/local/`. Both are checked so `npm run dev` behaves like a build.
 */
export function assetsDir(): string {
  const candidates = [
    join(__dirname, 'assets', 'local'),
    join(__dirname, '..', 'assets', 'local'),
    join(__dirname, '..', '..', 'assets', 'local'),
    join(__dirname, '..', '..', 'src', 'assets', 'local'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, CLI_OVERLAY))) return dir;
  }
  throw new CLIError(
    `${CLI_OVERLAY} is missing from this CLI installation.\n` +
      'Reinstall with `npm i -g @insforge/cli@latest`, or run via `npx -y @insforge/cli@latest`.',
  );
}

const OVERLAYS: Record<Exclude<StorageBackend, 'local'>, string> = {
  minio: 'docker-compose.minio.yml',
  rustfs: 'docker-compose.rustfs.yml',
};

/**
 * Upstream's compose file, the CLI's overlay, and a storage overlay if selected.
 *
 * Order matters: later files win, and the storage overlay has to see the service
 * definitions it extends. The storage overlays come from the checkout too — they
 * live in the same repository and setup.sh fetches them.
 */
export function composeFiles(storage: StorageBackend, cwd?: string): string[] {
  const files = [upstreamComposeFile(cwd), join(assetsDir(), CLI_OVERLAY)];
  if (storage !== 'local') files.push(join(checkoutDir(cwd), OVERLAYS[storage]));
  return files;
}

export interface ComposeContext {
  projectName: string;
  storage: StorageBackend;
  /** Directory holding .insforge/. Defaults to cwd. */
  cwd?: string;
}

export function composeArgs(ctx: ComposeContext, args: string[]): string[] {
  const fileArgs = composeFiles(ctx.storage, ctx.cwd).flatMap((f) => ['-f', f]);
  return [
    'compose',
    ...fileArgs,
    '--env-file',
    checkoutEnvFile(ctx.cwd),
    '-p',
    ctx.projectName,
    ...args,
  ];
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run a compose subcommand, capturing output. */
export function composeRun(ctx: ComposeContext, args: string[]): RunResult {
  const full = composeArgs(ctx, args);
  const r = spawnSync('docker', full, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) {
    throw new CLIError(`docker compose could not start: ${r.error.message}`);
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Run a compose subcommand, streaming output straight through (pulls, logs).
 */
export function composeRunInherit(ctx: ComposeContext, args: string[]): number {
  const r = spawnSync('docker', composeArgs(ctx, args), {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.error) {
    throw new CLIError(`docker compose could not start: ${r.error.message}`);
  }
  return r.status ?? 1;
}

export interface ServiceStatus {
  service: string;
  state: string;
  status: string;
  health: string;
}

/**
 * Parse `docker compose ps --format json`. Compose emits either one JSON object
 * per line or a single JSON array depending on version, so both are handled.
 */
export function parsePsJson(stdout: string): ServiceStatus[] {
  const raw = stdout.trim();
  if (!raw) return [];

  const records: Record<string, unknown>[] = [];
  if (raw.startsWith('[')) {
    try {
      records.push(...(JSON.parse(raw) as Record<string, unknown>[]));
    } catch {
      return [];
    }
  } else {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Skip a malformed line rather than losing the whole listing.
      }
    }
  }

  return records.map((r) => ({
    service: String(r.Service ?? r.Name ?? '?'),
    state: String(r.State ?? '?'),
    status: String(r.Status ?? ''),
    health: String(r.Health ?? ''),
  }));
}

/**
 * Volumes this project already owns, whether or not anything is running.
 *
 * `compose ps` only sees containers, and the case that matters here is a stopped
 * instance whose data is still on disk.
 */
export function projectVolumes(projectName: string): string[] {
  const r = spawnSync(
    'docker',
    ['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${projectName}`],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Never an empty list on failure. The caller that matters asks this to decide
  // whether generating fresh secrets would strand a database, and answering
  // "no volumes" because docker was unreachable is the one wrong answer.
  if (r.status !== 0) {
    throw new CLIError(
      `Could not list the volumes for ${projectName}.\n` +
        (r.stderr?.trim() || 'docker volume ls failed with no output.'),
    );
  }
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Remove volumes this project owns that `compose down -v` left behind.
 *
 * `down -v` only removes what the compose files it was given declare. Switching
 * --storage changes which overlay is in play, so the previous backend's volume
 * stops being named — and `--delete-data` reported success while a minio-data
 * full of objects stayed on disk.
 */
export interface VolumeSweep {
  removed: string[];
  /** Still on disk. Non-empty means the caller must not report a clean delete. */
  remaining: string[];
  error?: string;
}

export function removeProjectVolumes(projectName: string): VolumeSweep {
  const left = projectVolumes(projectName);
  if (left.length === 0) return { removed: [], remaining: [] };
  const r = spawnSync('docker', ['volume', 'rm', ...left], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status === 0) return { removed: left, remaining: [] };
  // Partial success is normal here: `docker volume rm a b c` removes what it
  // can and fails on the rest, so re-reading is the only way to know which.
  // Reporting "removed nothing" would have been wrong in both directions.
  const remaining = projectVolumes(projectName);
  return {
    removed: left.filter((v) => !remaining.includes(v)),
    remaining,
    error: r.stderr?.trim() || undefined,
  };
}

/**
 * Tear a project down with plain docker, no compose.
 *
 * Every compose call needs --env-file, so losing .insforge/checkout/.env leaves
 * `local stop --delete-data` unable to remove the containers it created — which
 * is precisely the state a refused start tells people to resolve that way.
 * Labels are enough to find them without any of the files.
 */
export function forceRemoveProject(projectName: string): { containers: number } {
  const filter = `label=com.docker.compose.project=${projectName}`;
  const ls = spawnSync('docker', ['ps', '-aq', '--filter', filter], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (ls.status !== 0) {
    throw new CLIError(
      `Could not list the containers for ${projectName}.\n` +
        (ls.stderr?.trim() || 'docker ps failed with no output.'),
    );
  }
  const ids = ls.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (ids.length > 0) {
    const rm = spawnSync('docker', ['rm', '-f', ...ids], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (rm.status !== 0) {
      throw new CLIError(
        `Could not remove the containers for ${projectName}.\n` +
          (rm.stderr?.trim() || 'docker rm failed with no output.'),
      );
    }
  }
  return { containers: ids.length };
}

export function composePs(ctx: ComposeContext): ServiceStatus[] {
  const r = composeRun(ctx, ['ps', '--format', 'json']);
  if (r.status !== 0) return [];
  return parsePsJson(r.stdout);
}
