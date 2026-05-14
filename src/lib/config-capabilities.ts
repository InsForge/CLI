// CLI/src/lib/config-capabilities.ts
//
// Capability detection by metadata-shape probing.
//
// InsForge backends evolve independently per project. A user's CLI is always
// the latest from npm; the project's backend may be on any prior release.
// We need to know which TOML sections the connected backend actually supports
// so apply/plan/export can degrade gracefully instead of silently dropping
// fields or hanging on schema mismatch.
//
// The protocol: a feature is supported iff its corresponding key appears in
// the raw `/api/metadata` response. Older backends that predate a feature
// simply omit the key. The CLI infers support from presence/absence — no
// version handshake, no new server endpoint.
//
// IMPORTANT: probe the RAW JSON, never the Zod-parsed object. Zod's
// `.default([])` on the consumer schema would silently fill in absent fields
// and erase the signal we're checking for.
//
// Server contract (documented in shared-schemas/metadata.schema.ts): when a
// backend doesn't yet support a TOML-relevant field, its `/api/metadata`
// response must OMIT the key — not emit it with an empty default. A
// `cfg.allowedRedirectUrls ?? []` on the response builder for an unsupported
// backend would defeat this probe.

import type { DiffChange } from './config-diff.js';

// The probe takes the metadata response loosely-typed: typed shapes from
// callers (RawMetadataResponse) and Record<string, unknown> both satisfy
// this. Runtime checks below verify the actual structure before reading.
type RawMetadata = {
  auth?: unknown;
  // Cloud-only slice. Self-host backends omit the key entirely — that's the
  // signal we use to gate [deployments] writes (self-host can't honor them).
  deployments?: unknown;
};

/**
 * True iff the backend's metadata response carries the field this change
 * targets. Used to skip unsupported changes before we'd PUT to an endpoint
 * that may silently drop the body.
 */
export function metadataSupports(raw: RawMetadata, change: DiffChange): boolean {
  if (change.section === 'auth' && change.key === 'allowed_redirect_urls') {
    return hasAuthKey(raw, 'allowedRedirectUrls');
  }
  if (change.section === 'auth' && change.key === 'require_email_verification') {
    return hasAuthKey(raw, 'requireEmailVerification');
  }
  if (change.section === 'auth' && change.key === 'verify_email_method') {
    return hasAuthKey(raw, 'verifyEmailMethod');
  }
  if (change.section === 'auth' && change.key === 'reset_password_method') {
    return hasAuthKey(raw, 'resetPasswordMethod');
  }
  if (change.section === 'auth.password') {
    // Per-key probes. The backend exposes each password policy field as a
    // flat key under `auth` (not a nested passwordPolicy object), so a
    // legacy backend that only added e.g. passwordMinLength but not the
    // require_* flags would still get partial support.
    return hasAuthKey(raw, AUTH_PASSWORD_WIRE_KEY[change.key]);
  }
  if (change.section === 'auth.smtp') {
    // SMTP is whole-object: a backend either exposes `smtpConfig` in
    // /api/metadata (and accepts PUT /api/auth/smtp-config) or doesn't.
    return hasAuthKey(raw, 'smtpConfig');
  }
  if (change.section === 'deployments' && change.key === 'subdomain') {
    // Presence-only probe: cloud backends always carry `customSlug` in the
    // slice (null when unset); self-host omits the whole `deployments` key.
    return (
      raw?.deployments !== undefined &&
      raw.deployments !== null &&
      typeof raw.deployments === 'object'
    );
  }
  // Exhaustiveness check — if a new DiffChange variant lands without a
  // matching probe, TS errors at compile time instead of silently dumping
  // every apply of that section into skipped[] forever.
  const _exhaustive: never = change;
  void _exhaustive;
  return false;
}

function hasAuthKey(raw: RawMetadata, key: string): boolean {
  const auth = raw?.auth;
  return auth !== undefined && auth !== null && typeof auth === 'object' && key in auth;
}

// Maps TOML keys under [auth.password] to the flat camelCase fields the
// backend emits on /api/metadata's auth slice. Single source of truth used
// by both the capability probe and the apply dispatcher (via authPasswordWireKey).
const AUTH_PASSWORD_WIRE_KEY: Record<
  'min_length' | 'require_number' | 'require_lowercase' | 'require_uppercase' | 'require_special_char',
  string
> = {
  min_length: 'passwordMinLength',
  require_number: 'requireNumber',
  require_lowercase: 'requireLowercase',
  require_uppercase: 'requireUppercase',
  require_special_char: 'requireSpecialChar',
};

/**
 * Human-readable path for a change, used in skipped/applied summaries.
 */
export function changePath(change: DiffChange): string {
  if (change.section === 'auth.smtp') return 'auth.smtp';
  return `${change.section}.${change.key}`;
}

/**
 * Wire-format key for an auth.password.* TOML field. Exposed so apply.ts can
 * build the PUT body without duplicating the camelCase mapping. Keeping this
 * here (next to the probe that uses the same table) means a future field add
 * touches one place.
 */
export function authPasswordWireKey(
  key: 'min_length' | 'require_number' | 'require_lowercase' | 'require_uppercase' | 'require_special_char',
): string {
  return AUTH_PASSWORD_WIRE_KEY[key];
}
