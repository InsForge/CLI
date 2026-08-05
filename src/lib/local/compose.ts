/**
 * Thin wrapper around `docker compose` for local instances.
 *
 * The compose files are bundled with the CLI (src/assets/local/) and reference
 * only published images and named volumes — nothing is mounted from a checkout —
 * so they run correctly from the npm package directory regardless of the user's
 * cwd. Ports, keys, and image tags are supplied through the generated
 * `--env-file` rather than by rewriting YAML.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIError } from '../errors.js';
import { localEnvFile } from './state.js';
import type { StorageBackend } from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the bundled compose assets. `dist/index.js` resolves to
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
    if (existsSync(join(dir, 'docker-compose.yml'))) return dir;
  }
  throw new CLIError(
    'Bundled compose files are missing from this CLI installation.\n' +
      'Reinstall with `npm i -g @insforge/cli@latest`, or run via `npx -y @insforge/cli@latest`.',
  );
}

const OVERLAYS: Record<Exclude<StorageBackend, 'local'>, string> = {
  minio: 'docker-compose.minio.yml',
  rustfs: 'docker-compose.rustfs.yml',
};

/**
 * Base file, then the Postgres overlay, then the storage overlay if any.
 *
 * The base file is a byte-identical copy of the InsForge repo's image-only
 * compose file, so it can be diff-checked against upstream. Every local-only
 * difference lives in an overlay instead of being edited into the copy.
 */
export function composeFiles(storage: StorageBackend): string[] {
  const dir = assetsDir();
  const files = [join(dir, 'docker-compose.yml'), join(dir, 'docker-compose.local.yml')];
  if (storage !== 'local') files.push(join(dir, OVERLAYS[storage]));
  return files;
}

/** Path to the bundled init SQL that `local start` materializes into .insforge/. */
export function bundledDbInitSql(): string {
  return join(assetsDir(), 'db-init.sql');
}

export interface ComposeContext {
  projectName: string;
  storage: StorageBackend;
  /** Directory holding .insforge/local.env. Defaults to cwd. */
  cwd?: string;
}

export function composeArgs(ctx: ComposeContext, args: string[]): string[] {
  const fileArgs = composeFiles(ctx.storage).flatMap((f) => ['-f', f]);
  return [
    'compose',
    ...fileArgs,
    '--env-file',
    localEnvFile(ctx.cwd),
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

export function composePs(ctx: ComposeContext): ServiceStatus[] {
  const r = composeRun(ctx, ['ps', '--format', 'json']);
  if (r.status !== 0) return [];
  return parsePsJson(r.stdout);
}
