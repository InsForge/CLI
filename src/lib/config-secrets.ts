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
