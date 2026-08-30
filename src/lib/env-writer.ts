import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface EnvUpdateResult {
  /** Variables that were appended (key was not already set). */
  added: string[];
  /** Variables that were already present with a matching value (skipped). */
  skipped: string[];
  /** Variables that were already present with a *different* value. NOT overwritten. */
  mismatched: { key: string; existingValue: string; newValue: string }[];
}

const KEY_LINE_RE = (key: string): RegExp =>
  // Match `KEY=...` at the start of a line (allowing leading whitespace).
  // Captures the value side; we only need the value portion to compare.
  new RegExp(`^\\s*${key.replace(/[$.*+?^()[\\]{}|]/g, '\\$&')}\\s*=\\s*(.*)$`, 'm');

function stripQuotes(v: string): string {
  const t = v.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  // Strip trailing inline `# comment` for unquoted values.
  const hash = t.indexOf(' #');
  return hash >= 0 ? t.slice(0, hash).trimEnd() : t;
}

/**
 * Update an env file by appending any keys that aren't already present.
 *
 * Behaviour matches spec §5.5:
 *   - If a key is already set with the same value → skip silently.
 *   - If a key is set with a different value → leave it alone (user pin),
 *     but record it in `mismatched` so the caller can warn.
 *   - If a key isn't present → append `KEY=value` at the end.
 *
 * The file is created if it doesn't exist. Comments and unrelated lines are
 * preserved verbatim.
 */
export function upsertEnvFile(
  path: string,
  entries: Record<string, string>,
): EnvUpdateResult {
  const exists = existsSync(path);
  let content = exists ? readFileSync(path, 'utf-8') : '';

  const result: EnvUpdateResult = { added: [], skipped: [], mismatched: [] };
  const additions: string[] = [];

  for (const [key, value] of Object.entries(entries)) {
    const re = KEY_LINE_RE(key);
    const match = content.match(re);
    if (match) {
      const existingValue = stripQuotes(match[1] ?? '');
      if (existingValue === value) {
        result.skipped.push(key);
      } else {
        result.mismatched.push({ key, existingValue, newValue: value });
      }
      continue;
    }
    additions.push(`${key}=${value}`);
    result.added.push(key);
  }

  if (additions.length > 0) {
    // Ensure the existing content ends with a newline before appending.
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n';
    }
    content += additions.join('\n') + '\n';
    writeFileSync(path, content);
  } else if (!exists) {
    // Nothing to add and file didn't exist — don't create an empty file.
  }

  return result;
}

/** True for the local env files git is expected to ignore: `.env.local` and
 *  `.env.<name>.local`. A plain `.env` is deliberately excluded — some projects
 *  commit a non-secret one on purpose, so we never touch it. */
export function isLocalEnvFile(envFile: string): boolean {
  const normalized = envFile.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  return basename === '.env.local' || /^\.env\..+\.local$/.test(basename);
}

/**
 * Make sure a local env file we just wrote credentials into is gitignored.
 * Shared by `ai setup` (which writes OPENROUTER_API_KEY) and the skills
 * install used by `link`/`create` (which seed .env.local and then point
 * AGENTS.md at it), so the ignore rule lives in exactly one place.
 *
 * No-ops when the file is not a local env file, when it resolves outside
 * `cwd` (nothing we should be editing a .gitignore for), or when an existing
 * pattern already covers it. Returns `true` only if .gitignore was written.
 */
export function ensureLocalEnvIgnored(cwd: string, envFile: string): boolean {
  if (!isLocalEnvFile(envFile)) return false;

  const envPath = resolve(cwd, envFile);
  const relEnvPath = relative(cwd, envPath);
  if (!relEnvPath || relEnvPath.startsWith('..') || isAbsolute(relEnvPath)) {
    return false;
  }

  const gitignorePath = join(cwd, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const envBasename = envFile.replace(/\\/g, '/').split('/').pop() ?? envFile;
  if (
    lines.has('.env*') ||
    lines.has('.env.*') ||
    lines.has('.env*.local') ||
    (lines.has('.env.local') && envBasename === '.env.local')
  ) {
    return false;
  }

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const spacer = existing.length > 0 ? '\n' : '';
  appendFileSync(gitignorePath, `${prefix}${spacer}# Local environment secrets\n.env*.local\n`);
  return true;
}
