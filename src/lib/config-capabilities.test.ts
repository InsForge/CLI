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

describe('metadataSupports — auth verification flags', () => {
  it('probes requireEmailVerification by presence', () => {
    const ch: DiffChange = {
      section: 'auth',
      op: 'modify',
      key: 'require_email_verification',
      from: false,
      to: true,
    };
    expect(metadataSupports({ auth: { requireEmailVerification: false } }, ch)).toBe(true);
    expect(metadataSupports({ auth: {} }, ch)).toBe(false);
  });

  it('probes verifyEmailMethod and resetPasswordMethod by presence', () => {
    const verify: DiffChange = {
      section: 'auth',
      op: 'modify',
      key: 'verify_email_method',
      from: 'code',
      to: 'link',
    };
    const reset: DiffChange = {
      section: 'auth',
      op: 'modify',
      key: 'reset_password_method',
      from: 'code',
      to: 'link',
    };
    const raw = { auth: { verifyEmailMethod: 'code', resetPasswordMethod: 'code' } };
    expect(metadataSupports(raw, verify)).toBe(true);
    expect(metadataSupports(raw, reset)).toBe(true);
    expect(metadataSupports({ auth: {} }, verify)).toBe(false);
    expect(metadataSupports({ auth: {} }, reset)).toBe(false);
  });

  it('probes disableSignup by presence', () => {
    const ch: DiffChange = {
      section: 'auth',
      op: 'modify',
      key: 'disable_signup',
      from: false,
      to: true,
    };
    expect(metadataSupports({ auth: { disableSignup: false } }, ch)).toBe(true);
    expect(metadataSupports({ auth: {} }, ch)).toBe(false);
  });
});

describe('metadataSupports — [auth.password] per-field', () => {
  const minLengthChange: DiffChange = {
    section: 'auth.password',
    op: 'modify',
    key: 'min_length',
    from: 8,
    to: 12,
  };
  const requireNumberChange: DiffChange = {
    section: 'auth.password',
    op: 'modify',
    key: 'require_number',
    from: false,
    to: true,
  };

  it('returns true when the matching flat camelCase key is present', () => {
    expect(metadataSupports({ auth: { passwordMinLength: 8 } }, minLengthChange)).toBe(true);
    expect(metadataSupports({ auth: { requireNumber: true } }, requireNumberChange)).toBe(true);
  });

  it('returns false when the matching key is absent', () => {
    // Backend exposed min_length but not require_number — only the supported
    // field passes the probe. Lets a future backend ship the policy fields
    // piecemeal without breaking the CLI.
    expect(metadataSupports({ auth: { passwordMinLength: 8 } }, requireNumberChange)).toBe(false);
    expect(metadataSupports({ auth: {} }, minLengthChange)).toBe(false);
  });
});

describe('changePath', () => {
  it('joins section and key with a dot', () => {
    expect(changePath(change)).toBe('auth.allowed_redirect_urls');
  });

  it('renders auth.password.* fields with the full path', () => {
    expect(
      changePath({
        section: 'auth.password',
        op: 'modify',
        key: 'min_length',
        from: 8,
        to: 12,
      }),
    ).toBe('auth.password.min_length');
  });
});

describe('metadataSupports — endpoint-backed sections', () => {
  it('uses endpoint responses for storage, realtime, and schedules support', () => {
    expect(
      metadataSupports(
        { auth: {} },
        {
          section: 'storage',
          op: 'modify',
          key: 'max_file_size_mb',
          from: 50,
          to: 100,
        },
        { storageConfig: { maxFileSizeMb: 50 } },
      ),
    ).toBe(true);
    expect(
      metadataSupports(
        { auth: {} },
        {
          section: 'realtime',
          op: 'modify',
          key: 'retention_days',
          from: null,
          to: 7,
        },
        { realtimeConfig: { retentionDays: null } },
      ),
    ).toBe(true);
    expect(
      metadataSupports(
        { auth: {} },
        {
          section: 'schedules',
          op: 'modify',
          key: 'retention_days',
          from: 7,
          to: 14,
        },
        { schedulesConfig: { retentionDays: 7 } },
      ),
    ).toBe(true);
  });
});
