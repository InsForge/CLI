/**
 * Thin wrapper around `docker compose` for local instances.
 *
 * The compose template is bundled with the CLI (src/assets/local/); the payloads
 * it inlines and the storage overlays come from the InsForge repository at the
 * pinned ref (see upstream.ts). The result references only published images and
 * named volumes — nothing is mounted from a checkout — so it runs correctly
 * regardless of the user's cwd. Ports, keys, and image tags are supplied through the generated
 * `--env-file` rather than by rewriting YAML.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIError } from '../errors.js';
import { ensureLocalDir, ensureLocalGitignore, localComposeFile, localEnvFile } from './state.js';
import { renderComposeFile, type ConfigSource } from './render.js';
import { DEFAULT_REF, upstreamDir } from './upstream.js';
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
    if (existsSync(join(dir, 'docker-compose.template.yml'))) return dir;
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
 * The rendered compose file, plus a storage overlay if one was selected.
 *
 * The rendered file lives in .insforge/ rather than in the package, so a user can
 * read exactly what ran. Neither it nor the overlays reference a relative path —
 * that is what broke the previous approach of bundling a copy of the upstream
 * compose file, whose ../docker-init/db/* mounts resolved inside the npm package.
 */
export function composeFiles(storage: StorageBackend, cwd?: string, ref?: string): string[] {
  const files = [localComposeFile(cwd)];
  if (storage !== 'local') {
    files.push(join(upstreamDir(ref ?? DEFAULT_REF, cwd), OVERLAYS[storage]));
  }
  return files;
}

/** Files whose contents are inlined into the rendered compose as configs. */
const CONFIG_ASSETS: { name: string; file: string }[] = [
  { name: 'db_init', file: 'db-init.sql' },
  { name: 'deno_server', file: 'server.ts' },
  { name: 'deno_worker', file: 'worker-template.js' },
];

/** Render the template into .insforge/local-compose.yml and return its path. */
export function writeRenderedCompose(ref: string, cwd?: string): string {
  const template = readFileSync(join(assetsDir(), 'docker-compose.template.yml'), 'utf-8');
  const upstream = upstreamDir(ref, cwd);
  const sources: ConfigSource[] = CONFIG_ASSETS.map(({ name, file }) => {
    const path = join(upstream, file);
    if (!existsSync(path)) {
      throw new CLIError(
        `${file} is missing from ${upstream}.\n` +
          'Run `insforge local start` to fetch the files this instance needs.',
      );
    }
    return { name, content: readFileSync(path, 'utf-8') };
  });
  ensureLocalDir(cwd);
  ensureLocalGitignore(cwd);
  const target = localComposeFile(cwd);
  writeFileSync(target, renderComposeFile(template, sources));
  return target;
}

export interface ComposeContext {
  projectName: string;
  storage: StorageBackend;
  /** Directory holding .insforge/local.env. Defaults to cwd. */
  cwd?: string;
  /** Ref whose upstream files this instance runs. Defaults to main. */
  ref?: string;
}

export function composeArgs(ctx: ComposeContext, args: string[]): string[] {
  const fileArgs = composeFiles(ctx.storage, ctx.cwd, ctx.ref).flatMap((f) => ['-f', f]);
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
