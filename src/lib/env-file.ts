import { readFileSync } from 'node:fs';
import { CLIError } from './errors.js';

const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;

// Minimal dotenv parser. Handles:
//   • KEY=VALUE lines
//   • Blank lines and # comment lines
//   • Optional surrounding quotes ("..." or '...') stripped from VALUE
//   • Inline trailing comments after unquoted values: KEY=val # note
//
// Keeps escape-sequence handling deliberately out of scope — anything fancy
// (multiline strings, $VAR expansion) belongs in a real dotenv library; for
// `compute deploy --env-file` the goal is feature-parity with `--env <json>`
// for the 95% case, not full dotenv semantics.
export function parseEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CLIError(`Could not read --env-file at ${path}: ${msg}`);
  }

  const result: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) {
      throw new CLIError(
        `${path}:${i + 1}: expected KEY=VALUE, got "${line}"`
      );
    }
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY_REGEX.test(key)) {
      throw new CLIError(
        `${path}:${i + 1}: invalid env var key "${key}" (must match [A-Z_][A-Z0-9_]*)`
      );
    }

    let value = line.slice(eq + 1).trim();

    // Surrounding quotes (matching pair) — strip them and use the inner
    // string verbatim. Anything inside quotes is preserved including '#'.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // Unquoted value — strip a trailing inline comment (`KEY=val # note`).
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }

    result[key] = value;
  }
  return result;
}
