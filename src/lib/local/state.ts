/**
 * On-disk state for a local InsForge instance.
 *
 * One instance per directory: the compose project name is derived from the
 * directory path, so two app folders get separate containers, volumes, and
 * databases without any configuration.
 *
 * Two files, split by what they hold:
 *   .insforge/local.json — non-secret machine state (ports, resolved version)
 *   .insforge/local.env  — generated secrets, mode 0600, fed to `--env-file`
 * Both are gitignored via .insforge/.gitignore so a `git add -A` can't commit
 * the keys.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type StorageBackend = 'local' | 'minio' | 'rustfs';

export interface LocalPorts {
  app: number;
  auth: number;
  deno: number;
  postgres: number;
  postgrest: number;
}

export interface LocalState {
  /** Schema version, so a future change can migrate rather than misread. */
  version: 1;
  /** `docker compose -p` value. Derived from the directory, stored so a later
   *  `local stop` targets the same containers even if the directory moved. */
  projectName: string;
  storage: StorageBackend;
  ports: LocalPorts;
  createdAt: string;
}

export const DEFAULT_PORTS: LocalPorts = {
  app: 7130,
  auth: 7131,
  deno: 7133,
  postgres: 5432,
  postgrest: 5430,
};

function localDir(cwd: string = process.cwd()): string {
  return join(cwd, '.insforge');
}

/** Create `.insforge/` if needed. Callers write into it without ordering rules. */
export function ensureLocalDir(cwd?: string): string {
  const dir = localDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function localStateFile(cwd?: string): string {
  return join(localDir(cwd), 'local.json');
}

export function localEnvFile(cwd?: string): string {
  return join(localDir(cwd), 'local.env');
}

/**
 * The rendered compose file. Generated on every start from the CLI's template so
 * a CLI upgrade always runs its own spec, and readable on disk so a user can
 * inspect or hand-run exactly what the CLI ran.
 */
export function localComposeFile(cwd?: string): string {
  return join(localDir(cwd), 'local-compose.yml');
}

/**
 * Compose project name for a directory. Docker requires lowercase
 * `[a-z0-9][a-z0-9_-]*`, so the basename is sanitized and suffixed with a hash
 * of the absolute path — the hash is what keeps two directories with the same
 * basename (`~/a/api` and `~/b/api`) from sharing containers.
 */
export function composeProjectName(cwd: string = process.cwd()): string {
  // Both separators, not node:path's basename: that one is platform-specific, so
  // a Windows path handed to a POSIX build keeps its backslashes and the whole
  // path becomes the name.
  const base = (cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'insforge')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 24);
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  return `insforge-${base || 'app'}-${hash}`;
}

export function readLocalState(cwd?: string): LocalState | null {
  const file = localStateFile(cwd);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as LocalState;
  } catch {
    // A truncated or hand-edited file shouldn't wedge `local stop`; callers
    // treat null as "no instance recorded" and can still be pointed at one
    // by re-running `local start`.
    return null;
  }
}

export function writeLocalState(state: LocalState, cwd?: string): void {
  ensureLocalDir(cwd);
  ensureLocalGitignore(cwd);
  writeFileSync(localStateFile(cwd), `${JSON.stringify(state, null, 2)}\n`);
}

export function clearLocalState(cwd?: string): void {
  for (const file of [localStateFile(cwd), localEnvFile(cwd), localComposeFile(cwd)]) {
    if (existsSync(file)) unlinkSync(file);
  }
}

/**
 * Keep the generated secrets and machine state out of git. Scoped to the two
 * files this feature adds — deliberately not `*`, which would also start
 * ignoring project.json for existing cloud-linked repos.
 */
export function ensureLocalGitignore(cwd?: string): void {
  const dir = ensureLocalDir(cwd);
  const file = join(dir, '.gitignore');
  const wanted = ['local.env', 'local.json', 'local-compose.yml'];
  const existing = existsSync(file)
    ? readFileSync(file, 'utf-8').split('\n').map((l) => l.trim())
    : [];
  const missing = wanted.filter((w) => !existing.includes(w));
  if (missing.length === 0) return;
  const body = existing.filter(Boolean).concat(missing).join('\n');
  writeFileSync(file, `${body}\n`);
}
