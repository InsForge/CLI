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

type RawMetadata = {
  auth?: Record<string, unknown>;
};

/**
 * True iff the backend's metadata response carries the field this change
 * targets. Used to skip unsupported changes before we'd PUT to an endpoint
 * that may silently drop the body.
 */
export function metadataSupports(raw: RawMetadata, change: DiffChange): boolean {
  if (change.section === 'auth' && change.key === 'allowed_redirect_urls') {
    return (
      raw?.auth !== undefined &&
      raw.auth !== null &&
      typeof raw.auth === 'object' &&
      'allowedRedirectUrls' in raw.auth
    );
  }
  return false;
}

/**
 * Human-readable path for a change, used in skipped/applied summaries.
 */
export function changePath(change: DiffChange): string {
  return `${change.section}.${change.key}`;
}
