/**
 * Fetch the files the local stack inlines from the InsForge repository.
 *
 * db-init.sql, the Deno function host and the storage overlays all live in
 * InsForge/InsForge. The CLI used to ship copies of them. A copy of a file whose
 * source of truth is another repository drifts, and it drifts silently: the
 * published ghcr.io/insforge/deno-runtime image is assembled that way, and its
 * copy of the function host matches no commit in the repository at all — 175
 * lines behind on worker-template.js, missing the fix for a 504 race.
 *
 * So they are fetched at the release tag this directory is pinned to, and cached
 * under .insforge/upstream/<ref>/. One source of truth, and the payloads always
 * match the images they run beside. A cached ref is never re-fetched, so this
 * costs one request per file on a first start and nothing afterwards.
 *
 * The ref follows the images: a resolved release tag fetches that tag, and no
 * tag — the registry was unreachable, or nothing is common to every image, so
 * compose falls back to :latest — fetches main, which is what :latest is built
 * from.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLIError } from '../errors.js';
import { ensureLocalDir } from './state.js';

const RAW_BASE = 'https://raw.githubusercontent.com/InsForge/InsForge';

/** Fallback ref when no release tag is pinned; :latest is built from main. */
export const DEFAULT_REF = 'main';

const FETCH_TIMEOUT_MS = 15_000;

/** Local filename → path in the InsForge repository. */
export const UPSTREAM_FILES: Record<string, string> = {
  'db-init.sql': 'deploy/docker-init/db/db-init.sql',
  'server.ts': 'functions/server.ts',
  'worker-template.js': 'functions/worker-template.js',
  'docker-compose.minio.yml': 'docker-compose.minio.yml',
  'docker-compose.rustfs.yml': 'docker-compose.rustfs.yml',
};

/** Where a ref's files are cached. Keyed by ref so a version bump re-fetches. */
export function upstreamDir(ref: string, cwd?: string): string {
  // --stack-tag takes whatever the user types and this is passed to mkdirSync.
  // Flatten anything that is not a tag character, then drop leading dots: a ref
  // of ".." survives the first pass intact and would resolve one level out of
  // the cache directory.
  const segment = ref.replace(/[^\w.-]/g, '_').replace(/^\.+/, '') || '_';
  return join(ensureLocalDir(cwd), 'upstream', segment);
}

/** True when every file for this ref is already cached and non-empty. */
export function upstreamCached(ref: string, cwd?: string): boolean {
  const dir = upstreamDir(ref, cwd);
  return Object.keys(UPSTREAM_FILES).every((name) => {
    const path = join(dir, name);
    return existsSync(path) && readFileSync(path, 'utf-8').trim().length > 0;
  });
}

async function fetchFile(ref: string, repoPath: string): Promise<string> {
  const url = `${RAW_BASE}/${ref}/${repoPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = await res.text();
    // A ref that does not exist returns 404, but a path that moved inside a real
    // ref can return an empty 200. Either way an empty payload would render a
    // compose file whose config carries nothing.
    if (body.trim().length === 0) throw new Error('empty response');
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make sure this ref's files are on disk, and return the directory holding them.
 *
 * Cached refs short-circuit, so a start with no network works as long as the
 * directory has been started once before at the same version.
 */
export async function ensureUpstreamFiles(ref: string, cwd?: string): Promise<string> {
  const dir = upstreamDir(ref, cwd);
  if (upstreamCached(ref, cwd)) return dir;

  mkdirSync(dir, { recursive: true });
  const failures: string[] = [];
  for (const [name, repoPath] of Object.entries(UPSTREAM_FILES)) {
    const target = join(dir, name);
    if (existsSync(target) && readFileSync(target, 'utf-8').trim().length > 0) continue;
    try {
      writeFileSync(target, await fetchFile(ref, repoPath));
    } catch (err) {
      failures.push(`${repoPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    throw new CLIError(
      `Could not fetch the InsForge files this stack needs at ${ref}:\n` +
        failures.map((f) => `  ${f}`).join('\n') +
        '\n\nThese come from github.com/InsForge/InsForge rather than being bundled,\n' +
        'so that they always match the images running beside them. Check network\n' +
        'access to raw.githubusercontent.com, or pass --stack-tag with a released\n' +
        'version.',
    );
  }
  return dir;
}
