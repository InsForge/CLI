// CLI/src/lib/config-secrets.ts
//
// Sensitive-field validation for insforge.toml.
//
// Sensitive fields (OAuth client_secret, SMTP password, S3 secret key, etc.)
// MUST be `env(NAME)` references in the TOML — never literal values. This is
// the same convention used by Vercel (vercel.json), Fly.io (fly.toml), and
// Supabase (supabase/config.toml). Rejecting literals at validation time
// makes the file unconditionally safe to commit to git.
//
// The actual secret VALUES live in the project's secrets store
// (`insforge secrets add NAME <value>`). The server resolves env() refs at
// apply time and fails loudly if the named secret is missing.
//
// This module is registered in config-schema.ts when sensitive fields are
// added to the TOML surface (SMTP password, OAuth client_secret, etc.).
// The MVP scope ([auth] allowed_redirect_urls only) has zero sensitive
// fields, so the validator is foundation-laid-but-not-yet-used. The first
// section to use it will be [email.smtp] or [auth.providers.<built_in>].

import { ConfigValidationError } from './config-schema.js';
import { ossFetch } from './api/oss.js';
import { CLIError } from './errors.js';

/** Matches `env(NAME)` where NAME is upper-snake-case. */
const ENV_REF_PATTERN = /^env\(([A-Z_][A-Z0-9_]*)\)$/;

/**
 * Returns the secret name (e.g. "GOOGLE_CLIENT_SECRET") if the value is a
 * well-formed env() reference. Returns null otherwise.
 */
export function parseEnvRef(value: string): string | null {
  const match = value.match(ENV_REF_PATTERN);
  return match ? match[1] : null;
}

/**
 * Validate a sensitive string field. Returns the env() reference unchanged
 * if it's well-formed; otherwise throws ConfigValidationError with an
 * actionable error message that names the exact `insforge secrets add`
 * command the user should run.
 *
 * @param path  The dotted path of the field (e.g. "email.smtp.password"),
 *              used in the error message.
 * @param value The value parsed from TOML — typically a string, but we
 *              accept unknown to keep the validator caller simple.
 * @param suggestedSecretName The conventional name to suggest in the error
 *              if the user pasted a literal (e.g. "SMTP_PASSWORD"). Should
 *              be UPPER_SNAKE_CASE.
 */
export function validateSensitiveString(
  path: string,
  value: unknown,
  suggestedSecretName: string,
): string {
  if (typeof value !== 'string') {
    throw new ConfigValidationError(path, 'must be a string');
  }

  if (parseEnvRef(value) !== null) {
    return value;
  }

  // Literal value (or malformed env() ref). Reject with an actionable error.
  throw new ConfigValidationError(
    path,
    `sensitive field must be an env() reference; got literal value.\n` +
      `  fix:\n` +
      `    1. insforge secrets add ${suggestedSecretName} "<value>"\n` +
      `    2. update insforge.toml:\n` +
      `         ${path.split('.').pop()} = "env(${suggestedSecretName})"\n` +
      `    3. insforge config apply`,
  );
}

/**
 * Resolve an env() ref against the project's InsForge secrets store. Returns
 * the decrypted value. Pre-flight check before `apply` PUTs anything — if
 * the named secret doesn't exist or is inactive, fail fast with an
 * actionable error rather than letting the backend emit a generic 400.
 *
 * Why the secrets store (not local env vars): secrets are shared per-project
 * across teammates, CI deploys, and dashboards. A `process.env.SMTP_PASSWORD`
 * from a developer's shell would create silent skew for everyone else.
 *
 * @param envRef The full env() reference (e.g. "env(SMTP_PASSWORD)").
 * @param fieldPath Dotted path of the field for error messages.
 */
export async function resolveEnvRef(envRef: string, fieldPath: string): Promise<string> {
  const secretName = parseEnvRef(envRef);
  if (!secretName) {
    // Defensive — callers should have already validated. If we reach here,
    // it means schema validation was bypassed somewhere upstream.
    throw new ConfigValidationError(
      fieldPath,
      `expected env() reference, got "${envRef}"`,
    );
  }

  let res: Response;
  try {
    res = await ossFetch(`/api/secrets/${encodeURIComponent(secretName)}`);
  } catch (err) {
    // ossFetch throws on any non-2xx, swallowing the status. Recover the
    // "missing secret" case from the error message — the backend's NOT_FOUND
    // path is the most common failure here and deserves the named code +
    // actionable hint, not a generic network error.
    const message = (err as Error).message ?? '';
    if (/not found/i.test(message)) {
      throw new CLIError(
        `${fieldPath} references env(${secretName}) but no such secret exists.\n` +
          `  fix: insforge secrets add ${secretName} "<value>"`,
        1,
        'SECRET_NOT_FOUND',
      );
    }
    // Other failures: re-wrap with the path context so users see what we
    // were trying to resolve when the lookup blew up.
    throw new CLIError(
      `failed to resolve env(${secretName}) for ${fieldPath}: ${message}`,
      1,
      'SECRET_LOOKUP_FAILED',
    );
  }

  if (!res.ok) {
    throw new CLIError(
      `failed to resolve env(${secretName}) for ${fieldPath}: HTTP ${res.status}`,
      1,
      'SECRET_LOOKUP_FAILED',
    );
  }

  const body = (await res.json()) as { value?: string };
  if (typeof body.value !== 'string' || body.value.length === 0) {
    throw new CLIError(
      `env(${secretName}) resolved to an empty value (secret may be inactive).\n` +
        `  fix: insforge secrets update ${secretName} --active true`,
      1,
      'SECRET_EMPTY',
    );
  }
  return body.value;
}
