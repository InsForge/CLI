// CLI/src/lib/config-metadata.ts
//
// Single source of truth for converting /api/metadata's raw JSON response
// into the LiveConfig shape the diff layer consumes. apply/plan/export all
// route through this to ensure they agree on what "live" looks like —
// otherwise plan vs apply could disagree on whether a field is a change.

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
  const a = raw.auth;

  if (a?.allowedRedirectUrls !== undefined) {
    live.auth!.allowed_redirect_urls = a.allowedRedirectUrls;
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
  if (a?.smtpConfig) {
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
  if (raw.deployments) {
    live.deployments = { subdomain: raw.deployments.customSlug ?? null };
  }
  return live;
}
