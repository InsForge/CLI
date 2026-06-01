// CLI/src/lib/config-metadata.ts
//
// Single source of truth for converting /api/metadata's raw JSON response
// into the shapes the rest of the CLI consumes:
//   - liveFromMetadata → LiveConfig for the diff layer (apply, plan)
//   - configFromMetadata → InsforgeConfig + skipped[] for export
//
// All field-presence detection lives here. apply / plan / export route
// through these two functions so a future field-mapping fix lands in one
// place rather than diverging across commands.

import {
  EMAIL_TEMPLATE_TYPES,
  isEmailTemplateType,
  type EmailTemplateConfig,
  type EmailTemplateType,
  type InsforgeConfig,
} from './config-schema.js';
import type { LiveConfig } from './config-diff.js';

/**
 * Raw shape of the backend's /api/metadata response. Only the keys this CLI
 * reads are listed; absent keys mean "backend doesn't yet support this
 * field" — used by capability probes and export's emission decision.
 */
export interface RawAuthMetadata {
  allowedRedirectUrls?: string[];
  requireEmailVerification?: boolean;
  verifyEmailMethod?: string;
  resetPasswordMethod?: string;
  passwordMinLength?: number;
  requireNumber?: boolean;
  requireLowercase?: boolean;
  requireUppercase?: boolean;
  requireSpecialChar?: boolean;
  disableSignup?: boolean;
  smtpConfig?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    username?: string;
    hasPassword?: boolean;
    senderEmail?: string;
    senderName?: string;
    minIntervalSeconds?: number;
  };
}

export interface RawStorageConfig {
  maxFileSizeMb?: unknown;
}

export interface RawRetentionConfig {
  retentionDays?: unknown;
}

export interface RawEmailTemplateMetadata {
  templateType?: unknown;
  subject?: unknown;
  bodyHtml?: unknown;
}

export interface RawConfigState {
  metadata: RawMetadataResponse;
  storageConfig?: RawStorageConfig;
  realtimeConfig?: RawRetentionConfig;
  schedulesConfig?: RawRetentionConfig;
  emailTemplates?: RawEmailTemplateMetadata[];
}

export interface RawMetadataResponse {
  auth?: RawAuthMetadata;
  // Cloud-only slice. Self-host or pre-#1259 backends omit the key
  // entirely; presence is the signal used to decide whether [deployments]
  // writes are honored.
  deployments?: {
    customSlug?: string | null;
  };
}

/**
 * Project the raw metadata response onto the shape diffConfig accepts.
 * Missing fields stay undefined — the diff layer interprets that as
 * "field not yet supported on this backend" and uses its own fallback
 * defaults when the file references a missing-on-live field.
 */
export function liveFromMetadata(raw: RawMetadataResponse): LiveConfig {
  const live: LiveConfig = { auth: {} };
  // Guard against a malformed response (auth: "string" / number / null) —
  // the `in` operator throws a TypeError on non-objects, so refuse to read
  // anything from a wrong-shaped slice instead of crashing the command.
  const a = isPlainObject(raw.auth) ? raw.auth : undefined;

  if (a && 'allowedRedirectUrls' in a) {
    // Belt-and-braces: even after the auth-slice typeof guard, a malformed
    // payload could ship `allowedRedirectUrls: "https://..."` (string) or
    // `null` and crash `normalizeUrlList` / TOML rendering downstream. Coerce
    // a wrong-shaped value to `[]` so the diff layer just shows the user
    // their TOML's URLs as additions.
    live.auth!.allowed_redirect_urls = asStringArray(a.allowedRedirectUrls) ?? [];
  }
  if (a && 'requireEmailVerification' in a) {
    live.auth!.require_email_verification = a.requireEmailVerification ?? false;
  }
  if (
    a &&
    'verifyEmailMethod' in a &&
    (a.verifyEmailMethod === 'code' || a.verifyEmailMethod === 'link')
  ) {
    live.auth!.verify_email_method = a.verifyEmailMethod;
  }
  if (
    a &&
    'resetPasswordMethod' in a &&
    (a.resetPasswordMethod === 'code' || a.resetPasswordMethod === 'link')
  ) {
    live.auth!.reset_password_method = a.resetPasswordMethod;
  }
  if (a && 'disableSignup' in a) {
    live.auth!.disable_signup = a.disableSignup ?? false;
  }
  // Build the password slice only if the backend exposed at least one field
  // (legacy backends omit the lot). Missing individual fields fall back to
  // the same defaults the diff layer uses, so a backend that adds them
  // piecemeal still produces a coherent live view.
  if (
    a &&
    ('passwordMinLength' in a ||
      'requireNumber' in a ||
      'requireLowercase' in a ||
      'requireUppercase' in a ||
      'requireSpecialChar' in a)
  ) {
    live.auth!.password = {
      min_length: a.passwordMinLength ?? 8,
      require_number: a.requireNumber ?? false,
      require_lowercase: a.requireLowercase ?? false,
      require_uppercase: a.requireUppercase ?? false,
      require_special_char: a.requireSpecialChar ?? false,
    };
  }
  // Build live.smtp only when the backend has actual data. `smtpConfig: null`
  // means the backend supports SMTP but no row exists yet — the diff layer's
  // empty-state defaults already cover that case.
  if (isPlainObject(a?.smtpConfig)) {
    const s = a.smtpConfig;
    live.auth!.smtp = {
      enabled: s.enabled ?? false,
      host: s.host ?? '',
      port: s.port ?? 587,
      username: s.username ?? '',
      hasPassword: s.hasPassword ?? false,
      sender_email: s.senderEmail ?? '',
      sender_name: s.senderName ?? '',
      min_interval_seconds: s.minIntervalSeconds ?? 60,
    };
  }
  const d = isPlainObject(raw.deployments) ? raw.deployments : undefined;
  if (d) {
    // Match the string-shape guard in configFromMetadata: a wrong-typed
    // customSlug (e.g. `123`) degrades to null rather than leaking into
    // live.deployments.subdomain — the diff layer would otherwise compare
    // numbers to strings and produce nonsense changes.
    live.deployments = {
      subdomain: typeof d.customSlug === 'string' && d.customSlug ? d.customSlug : null,
    };
  }
  return live;
}

export function liveFromConfigState(state: RawConfigState): LiveConfig {
  const live = liveFromMetadata(state.metadata);

  const maxFileSizeMb = asNumber(state.storageConfig?.maxFileSizeMb);
  if (maxFileSizeMb !== undefined) {
    live.storage = { max_file_size_mb: maxFileSizeMb };
  }

  const realtimeRetention = asRetentionDays(state.realtimeConfig?.retentionDays);
  if (realtimeRetention !== undefined) {
    live.realtime = { retention_days: realtimeRetention };
  }

  const schedulesRetention = asRetentionDays(state.schedulesConfig?.retentionDays);
  if (schedulesRetention !== undefined) {
    live.schedules = { retention_days: schedulesRetention };
  }

  const templates = readEmailTemplates(state.emailTemplates);
  if (templates !== undefined) {
    live.auth = live.auth ?? {};
    live.auth.email_templates = templates;
  }

  return live;
}

function isPlainObject<T extends object>(v: T | undefined | null | unknown): v is T {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function asRetentionDays(v: unknown): number | null | undefined {
  if (v === null) return null;
  return asNumber(v);
}

function readEmailTemplates(
  templates: RawEmailTemplateMetadata[] | undefined,
): Partial<Record<EmailTemplateType, EmailTemplateConfig>> | undefined {
  if (!Array.isArray(templates)) return undefined;
  const out: Partial<Record<EmailTemplateType, EmailTemplateConfig>> = {};
  for (const t of templates) {
    const templateType = typeof t.templateType === 'string' ? t.templateType : '';
    if (
      isEmailTemplateType(templateType) &&
      typeof t.subject === 'string' &&
      typeof t.bodyHtml === 'string'
    ) {
      out[templateType] = {
        subject: t.subject,
        body_html: t.bodyHtml,
      };
    }
  }
  return out;
}

/**
 * Project the raw metadata response onto an InsforgeConfig suitable for
 * writing back as `insforge.toml`. Mirrors liveFromMetadata's presence
 * detection but emits the schema shape (optional everything) and tracks
 * sections the backend doesn't yet expose so export can warn the user.
 *
 * Diverges from `liveFromMetadata` only in output shape, not in WHICH
 * fields are considered present — the two MUST agree, otherwise re-applying
 * an export wouldn't round-trip cleanly. Update both together.
 */
export function configFromMetadata(raw: RawMetadataResponse): {
  config: InsforgeConfig;
  skipped: string[];
} {
  const config: InsforgeConfig = {};
  const skipped: string[] = [];
  // Same defensive narrowing as liveFromMetadata — a non-object auth slice
  // means "this backend exposes nothing", not "crash on `in`".
  const a = isPlainObject(raw.auth) ? raw.auth : undefined;

  if (a && 'allowedRedirectUrls' in a) {
    // Wrong-shaped value (non-array) still counts as "supported" — fall back
    // to [] for the TOML rather than crashing the export.
    config.auth = config.auth ?? {};
    config.auth.allowed_redirect_urls = asStringArray(a.allowedRedirectUrls) ?? [];
  } else {
    skipped.push('auth.allowed_redirect_urls');
  }

  if (a && 'requireEmailVerification' in a) {
    config.auth = config.auth ?? {};
    config.auth.require_email_verification = a.requireEmailVerification ?? false;
  } else {
    skipped.push('auth.require_email_verification');
  }

  // Unknown enum values (anything other than 'code'/'link') fall back to
  // "skipped" rather than passing through. Reason: the parser would reject
  // an unknown literal at the next `config apply`, so emitting it would
  // produce a TOML the CLI can't read back. If the backend ever introduces
  // a new method, the CLI must teach the validator about it first.
  if (
    a &&
    'verifyEmailMethod' in a &&
    (a.verifyEmailMethod === 'code' || a.verifyEmailMethod === 'link')
  ) {
    config.auth = config.auth ?? {};
    config.auth.verify_email_method = a.verifyEmailMethod;
  } else {
    skipped.push('auth.verify_email_method');
  }

  if (
    a &&
    'resetPasswordMethod' in a &&
    (a.resetPasswordMethod === 'code' || a.resetPasswordMethod === 'link')
  ) {
    config.auth = config.auth ?? {};
    config.auth.reset_password_method = a.resetPasswordMethod;
  } else {
    skipped.push('auth.reset_password_method');
  }

  if (a && 'disableSignup' in a) {
    config.auth = config.auth ?? {};
    config.auth.disable_signup = a.disableSignup ?? false;
  } else {
    skipped.push('auth.disable_signup');
  }

  // Emit [auth.password] only when the backend exposes at least one policy
  // field. Each present field copies through; missing fields stay out of
  // the TOML so re-applying the export is a no-op (default-keep).
  if (
    a &&
    ('passwordMinLength' in a ||
      'requireNumber' in a ||
      'requireLowercase' in a ||
      'requireUppercase' in a ||
      'requireSpecialChar' in a)
  ) {
    config.auth = config.auth ?? {};
    config.auth.password = {};
    if ('passwordMinLength' in a) config.auth.password.min_length = a.passwordMinLength ?? 8;
    if ('requireNumber' in a) config.auth.password.require_number = a.requireNumber ?? false;
    if ('requireLowercase' in a) config.auth.password.require_lowercase = a.requireLowercase ?? false;
    if ('requireUppercase' in a) config.auth.password.require_uppercase = a.requireUppercase ?? false;
    if ('requireSpecialChar' in a) {
      config.auth.password.require_special_char = a.requireSpecialChar ?? false;
    }
  } else {
    skipped.push('auth.password');
  }

  // Presence-based gating to match the rest of the file: `smtpConfig` key
  // exists ⇒ backend supports SMTP, even when its value is null (no row yet).
  // Only emit the [auth.smtp] block when there's actual data to render.
  if (a && 'smtpConfig' in a) {
    const s = a.smtpConfig;
    if (isPlainObject(s)) {
      config.auth = config.auth ?? {};
      config.auth.smtp = {
        enabled: s.enabled ?? false,
        host: s.host ?? '',
        port: s.port ?? 587,
        username: s.username ?? '',
        // When backend has a password set, emit a deterministic env() placeholder
        // so the user knows which secret to define. We do NOT round-trip the
        // value (it never leaves the backend). Re-applying this TOML force-resends
        // from the secrets store — see config-diff.ts for the force-resend rationale.
        ...(s.hasPassword ? { password: 'env(SMTP_PASSWORD)' } : {}),
        sender_email: s.senderEmail ?? '',
        sender_name: s.senderName ?? '',
        min_interval_seconds: s.minIntervalSeconds ?? 60,
      };
    }
    // smtpConfig: null is "supported but blank" — don't emit a block, don't
    // mark as skipped. Matches capability-probe semantics.
  } else {
    skipped.push('auth.smtp');
  }

  const d = isPlainObject(raw.deployments) ? raw.deployments : undefined;
  if (d) {
    // Cloud backend exposes the slice. Only emit a value when a slug is
    // actually set — an unset slug means the project is on its default URL,
    // and surfacing subdomain = "" in the TOML would imply "clear on apply"
    // (and fail the backend's 3-char min).
    if (typeof d.customSlug === 'string' && d.customSlug) {
      config.deployments = { subdomain: d.customSlug };
    }
  } else {
    skipped.push('deployments.subdomain');
  }

  return { config, skipped };
}

export function configFromConfigState(state: RawConfigState): {
  config: InsforgeConfig;
  skipped: string[];
} {
  const { config, skipped } = configFromMetadata(state.metadata);

  const maxFileSizeMb = asNumber(state.storageConfig?.maxFileSizeMb);
  if (maxFileSizeMb !== undefined) {
    config.storage = { max_file_size_mb: maxFileSizeMb };
  } else {
    skipped.push('storage.max_file_size_mb');
  }

  const realtimeRetention = asRetentionDays(state.realtimeConfig?.retentionDays);
  if (realtimeRetention !== undefined) {
    config.realtime = { retention_days: realtimeRetention };
  } else {
    skipped.push('realtime.retention_days');
  }

  const schedulesRetention = asRetentionDays(state.schedulesConfig?.retentionDays);
  if (schedulesRetention !== undefined) {
    config.schedules = { retention_days: schedulesRetention };
  } else {
    skipped.push('schedules.retention_days');
  }

  const templates = readEmailTemplates(state.emailTemplates);
  if (templates !== undefined) {
    if (hasAnyEmailTemplate(templates)) {
      config.auth = config.auth ?? {};
      config.auth.email_templates = {};
      for (const type of EMAIL_TEMPLATE_TYPES) {
        if (templates[type]) config.auth.email_templates[type] = templates[type];
      }
    }
  } else {
    skipped.push('auth.email_templates');
  }

  return { config, skipped };
}

function hasAnyEmailTemplate(
  templates: Partial<Record<EmailTemplateType, EmailTemplateConfig>>,
): boolean {
  return EMAIL_TEMPLATE_TYPES.some((type) => templates[type] !== undefined);
}
