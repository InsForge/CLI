import * as smolToml from 'smol-toml';
import {
  EMAIL_TEMPLATE_TYPES,
  validateConfig,
  type AuthConfig,
  type EmailTemplateConfig,
  type EmailTemplateType,
  type InsforgeConfig,
  type PasswordConfig,
  type RetentionConfig,
  type StorageConfig,
  type SmtpConfig,
} from './config-schema.js';
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
 * (project_id → auth → auth.password → auth.smtp → auth.email_templates
 * → storage → realtime → schedules → deployments) so diffs are stable
 * across runs of `insforge config export`.
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
    renderAuthFlatFields(config.auth, lines);
    lines.push('');

    // Sub-tables emit in fixed order so exported TOML is stable across runs;
    // smol-toml's stringify would reorder these without our guarantee.
    if (config.auth.password !== undefined) {
      lines.push('[auth.password]');
      renderPasswordFields(config.auth.password, lines);
      lines.push('');
    }

    if (config.auth.smtp !== undefined) {
      lines.push('[auth.smtp]');
      renderSmtpFields(config.auth.smtp, lines);
      lines.push('');
    }

    if (config.auth.email_templates !== undefined) {
      renderEmailTemplates(config.auth.email_templates, lines);
    }
  }

  if (config.storage) {
    lines.push('[storage]');
    renderStorageFields(config.storage, lines);
    lines.push('');
  }

  if (config.realtime) {
    lines.push('[realtime]');
    renderRetentionFields(config.realtime, lines);
    lines.push('');
  }

  if (config.schedules) {
    lines.push('[schedules]');
    renderRetentionFields(config.schedules, lines);
    lines.push('');
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

function renderAuthFlatFields(auth: AuthConfig, lines: string[]): void {
  if (auth.allowed_redirect_urls !== undefined) {
    const urls = auth.allowed_redirect_urls.map((u) => JSON.stringify(u)).join(', ');
    lines.push(`allowed_redirect_urls = [${urls}]`);
  }
  if (auth.require_email_verification !== undefined) {
    lines.push(`require_email_verification = ${auth.require_email_verification}`);
  }
  if (auth.verify_email_method !== undefined) {
    lines.push(`verify_email_method = ${JSON.stringify(auth.verify_email_method)}`);
  }
  if (auth.reset_password_method !== undefined) {
    lines.push(`reset_password_method = ${JSON.stringify(auth.reset_password_method)}`);
  }
  if (auth.disable_signup !== undefined) {
    lines.push(`disable_signup = ${auth.disable_signup}`);
  }
}

function renderPasswordFields(pw: PasswordConfig, lines: string[]): void {
  if (pw.min_length !== undefined) lines.push(`min_length = ${pw.min_length}`);
  if (pw.require_number !== undefined) lines.push(`require_number = ${pw.require_number}`);
  if (pw.require_lowercase !== undefined) {
    lines.push(`require_lowercase = ${pw.require_lowercase}`);
  }
  if (pw.require_uppercase !== undefined) {
    lines.push(`require_uppercase = ${pw.require_uppercase}`);
  }
  if (pw.require_special_char !== undefined) {
    lines.push(`require_special_char = ${pw.require_special_char}`);
  }
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

function renderEmailTemplates(
  templates: Partial<Record<EmailTemplateType, EmailTemplateConfig>>,
  lines: string[],
): void {
  for (const type of EMAIL_TEMPLATE_TYPES) {
    const template = templates[type];
    if (!template) continue;
    lines.push(`[auth.email_templates.${JSON.stringify(type)}]`);
    lines.push(`subject = ${JSON.stringify(template.subject)}`);
    lines.push(`body_html = ${JSON.stringify(template.body_html)}`);
    lines.push('');
  }
}

function renderStorageFields(storage: StorageConfig, lines: string[]): void {
  if (storage.max_file_size_mb !== undefined) {
    lines.push(`max_file_size_mb = ${storage.max_file_size_mb}`);
  }
}

function renderRetentionFields(config: RetentionConfig, lines: string[]): void {
  if ('retention_days' in config) {
    // TOML has no null literal; 0 is our explicit "disabled" spelling.
    lines.push(`retention_days = ${config.retention_days ?? 0}`);
  }
}
