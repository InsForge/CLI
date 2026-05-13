import * as smolToml from 'smol-toml';
import { validateConfig, type InsforgeConfig, type SmtpConfig } from './config-schema.js';
import { parseEnvRef } from './config-secrets.js';

export function parseConfigToml(input: string): InsforgeConfig {
  let parsed: unknown;
  try {
    parsed = smolToml.parse(input);
  } catch (err) {
    throw new Error(`TOML parse error: ${(err as Error).message}`, { cause: err });
  }
  return validateConfig(parsed);
}

/**
 * Render a normalized config back to TOML. Section ordering is deterministic
 * (project_id → auth → auth.smtp) so diffs are stable across runs of
 * `insforge config export`.
 *
 * The renderer is intentionally hand-rolled rather than using smol-toml's
 * stringify: smol-toml doesn't preserve field order, and we want a stable
 * lexical layout that survives git diff/code review.
 */
export function stringifyConfigToml(config: InsforgeConfig): string {
  const lines: string[] = [];

  if (config.project_id !== undefined) {
    lines.push(`project_id = ${JSON.stringify(config.project_id)}`);
    lines.push('');
  }

  if (config.auth) {
    lines.push('[auth]');
    if (config.auth.allowed_redirect_urls !== undefined) {
      const urls = config.auth.allowed_redirect_urls
        .map((u) => JSON.stringify(u))
        .join(', ');
      lines.push(`allowed_redirect_urls = [${urls}]`);
    }
    lines.push('');

    if (config.auth.smtp !== undefined) {
      lines.push('[auth.smtp]');
      renderSmtpFields(config.auth.smtp, lines);
      lines.push('');
    }
  }

  if (config.deployments) {
    // TOML has no null literal, and "" would be ambiguous (clear vs unset).
    // Convention: omit the section entirely when subdomain is null/undefined.
    // To clear an existing slug via apply, the user writes subdomain = "" —
    // the diff/apply layer normalizes empty string to null.
    if (typeof config.deployments.subdomain === 'string' && config.deployments.subdomain !== '') {
      lines.push('[deployments]');
      lines.push(`subdomain = ${JSON.stringify(config.deployments.subdomain)}`);
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n+$/, '\n');
}

function renderSmtpFields(smtp: SmtpConfig, lines: string[]): void {
  if (smtp.enabled !== undefined) lines.push(`enabled = ${smtp.enabled}`);
  if (smtp.host !== undefined) lines.push(`host = ${JSON.stringify(smtp.host)}`);
  if (smtp.port !== undefined) lines.push(`port = ${smtp.port}`);
  if (smtp.username !== undefined) lines.push(`username = ${JSON.stringify(smtp.username)}`);
  if (smtp.password !== undefined) {
    // password is always an env() ref at this point (schema validator rejects
    // literals at parse time). Emit a comment naming the *actual* secret —
    // hardcoding SMTP_PASSWORD here would mislead anyone who named their
    // ref differently (e.g. env(PROD_SMTP_PASS)).
    const secretName = parseEnvRef(smtp.password) ?? 'SMTP_PASSWORD';
    lines.push(
      `# password is managed via secrets — run \`insforge secrets add ${secretName} "<value>"\``,
    );
    lines.push(`password = ${JSON.stringify(smtp.password)}`);
  }
  if (smtp.sender_email !== undefined) {
    lines.push(`sender_email = ${JSON.stringify(smtp.sender_email)}`);
  }
  if (smtp.sender_name !== undefined) {
    lines.push(`sender_name = ${JSON.stringify(smtp.sender_name)}`);
  }
  if (smtp.min_interval_seconds !== undefined) {
    lines.push(`min_interval_seconds = ${smtp.min_interval_seconds}`);
  }
}
