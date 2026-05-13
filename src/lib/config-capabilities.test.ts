import { describe, expect, it } from 'vitest';
import { metadataSupports, changePath } from './config-capabilities.js';
import type { DiffChange } from './config-diff.js';

const change: DiffChange = {
  section: 'auth',
  op: 'modify',
  key: 'allowed_redirect_urls',
  from: [],
  to: ['https://a.com'],
};

describe('metadataSupports', () => {
  it('returns true when the field is present in the raw response', () => {
    const raw = { auth: { allowedRedirectUrls: ['https://b.com'] } };
    expect(metadataSupports(raw, change)).toBe(true);
  });

  it('returns true even when the field value is an empty array', () => {
    // Empty != absent. A modern backend with no URLs configured still
    // emits the key; the CLI must treat that as "supported, currently empty."
    const raw = { auth: { allowedRedirectUrls: [] } };
    expect(metadataSupports(raw, change)).toBe(true);
  });

  it('returns true when the field value is null', () => {
    // Server choice; not the CLI's place to second-guess. Presence is the
    // signal — null is a valid emitted value.
    const raw = { auth: { allowedRedirectUrls: null } };
    expect(metadataSupports(raw, change)).toBe(true);
  });

  it('returns false when the auth slice exists but omits the field', () => {
    // This is the legacy-backend case: auth metadata is returned, but the
    // pre-v1.4 build doesn't know about the field at all.
    const raw = { auth: { someOtherField: 'value' } };
    expect(metadataSupports(raw, change)).toBe(false);
  });

  it('returns false when the auth slice is absent', () => {
    const raw = {};
    expect(metadataSupports(raw, change)).toBe(false);
  });

  it('returns false when raw is malformed', () => {
    expect(metadataSupports({ auth: null as unknown as Record<string, unknown> }, change)).toBe(
      false,
    );
  });

  it('returns false for unknown section/key combinations', () => {
    const unknown: DiffChange = {
      section: 'auth',
      op: 'modify',
      key: 'something_new' as 'allowed_redirect_urls',
      from: [],
      to: [],
    };
    const raw = { auth: { allowedRedirectUrls: [] } };
    expect(metadataSupports(raw, unknown)).toBe(false);
  });
});

describe('metadataSupports — deployments.subdomain', () => {
  const change: DiffChange = {
    section: 'deployments',
    op: 'modify',
    key: 'subdomain',
    from: null,
    to: 'my-app',
  };

  it('returns true when the deployments slice is present (cloud backend)', () => {
    expect(metadataSupports({ deployments: { customSlug: null } }, change)).toBe(true);
  });

  it('returns true when the slice carries a non-null slug', () => {
    expect(metadataSupports({ deployments: { customSlug: 'set' } }, change)).toBe(true);
  });

  it('returns false when the slice is omitted (self-host or pre-#1259 backend)', () => {
    // Critical version-skew guard: a backend that doesn't expose
    // deployments must not receive a slug PUT — self-host's slug endpoint
    // 503s, and a pre-#1259 cloud backend would have no metadata round-trip
    // to detect the field at all.
    expect(metadataSupports({ auth: { allowedRedirectUrls: [] } }, change)).toBe(false);
  });
});

describe('changePath', () => {
  it('joins section and key with a dot', () => {
    expect(changePath(change)).toBe('auth.allowed_redirect_urls');
  });
});
