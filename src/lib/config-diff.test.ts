import { describe, expect, it } from 'vitest';
import { diffConfig } from './config-diff.js';

describe('diffConfig', () => {
  it('detects an array change in allowed_redirect_urls', () => {
    const live = { auth: { allowed_redirect_urls: ['https://a.com'] } };
    const file = { auth: { allowed_redirect_urls: ['https://a.com', 'https://b.com'] } };
    expect(diffConfig({ live, file })).toEqual({
      changes: [
        {
          section: 'auth',
          op: 'modify',
          key: 'allowed_redirect_urls',
          from: ['https://a.com'],
          to: ['https://a.com', 'https://b.com'],
        },
      ],
      summary: { add: 0, modify: 1, remove: 0, kept: 0 },
    });
  });

  it('returns no changes for converged state', () => {
    const same = { auth: { allowed_redirect_urls: ['https://a.com'] } };
    expect(diffConfig({ live: same, file: same })).toEqual({
      changes: [],
      summary: { add: 0, modify: 0, remove: 0, kept: 0 },
    });
  });

  it('treats missing field in file as no-op (no remove)', () => {
    const live = { auth: { allowed_redirect_urls: ['https://a.com'] } };
    const file = {};
    expect(diffConfig({ live, file })).toEqual({
      changes: [],
      summary: { add: 0, modify: 0, remove: 0, kept: 0 },
    });
  });

  it('treats empty-array vs non-empty as a real change', () => {
    const live = { auth: { allowed_redirect_urls: ['https://a.com'] } };
    const file = { auth: { allowed_redirect_urls: [] } };
    expect(diffConfig({ live, file }).changes).toEqual([
      {
        section: 'auth',
        op: 'modify',
        key: 'allowed_redirect_urls',
        from: ['https://a.com'],
        to: [],
      },
    ]);
  });

  it('treats reordered redirect URLs as no-op', () => {
    const live = { auth: { allowed_redirect_urls: ['https://b.com', 'https://a.com'] } };
    const file = { auth: { allowed_redirect_urls: ['https://a.com', 'https://b.com'] } };
    expect(diffConfig({ live, file }).changes).toEqual([]);
  });

  it('deduplicates redirect URLs before comparing', () => {
    const live = { auth: { allowed_redirect_urls: ['https://a.com', 'https://a.com'] } };
    const file = { auth: { allowed_redirect_urls: ['https://a.com'] } };
    expect(diffConfig({ live, file }).changes).toEqual([]);
  });

  it('emits normalized values when there is a real change', () => {
    const live = { auth: { allowed_redirect_urls: ['https://b.com', 'https://a.com'] } };
    const file = {
      auth: { allowed_redirect_urls: ['https://c.com', 'https://a.com', 'https://b.com'] },
    };
    expect(diffConfig({ live, file }).changes).toEqual([
      {
        section: 'auth',
        op: 'modify',
        key: 'allowed_redirect_urls',
        from: ['https://a.com', 'https://b.com'],
        to: ['https://a.com', 'https://b.com', 'https://c.com'],
      },
    ]);
  });
});

const LIVE_SMTP_EMPTY = {
  enabled: false,
  host: '',
  port: 587,
  username: '',
  hasPassword: false,
  sender_email: '',
  sender_name: '',
  min_interval_seconds: 60,
};

const LIVE_SMTP_CONFIGURED = {
  enabled: true,
  host: 'smtp.gmail.com',
  port: 587,
  username: 'user@gmail.com',
  hasPassword: true,
  sender_email: 'noreply@app.com',
  sender_name: 'App',
  min_interval_seconds: 60,
};

describe('diffConfig — auth.smtp', () => {
  it('emits a single auth.smtp change with all field updates', () => {
    const live = { auth: { smtp: LIVE_SMTP_EMPTY } };
    const file = {
      auth: {
        smtp: {
          enabled: true,
          host: 'smtp.gmail.com',
          port: 587,
          username: 'user@gmail.com',
          password: 'env(SMTP_PASSWORD)',
          sender_email: 'noreply@app.com',
          sender_name: 'App',
          min_interval_seconds: 60,
        },
      },
    };
    const result = diffConfig({ live, file });
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0];
    expect(change.section).toBe('auth.smtp');
    if (change.section === 'auth.smtp') {
      expect(change.from.host).toBe('');
      expect(change.to.host).toBe('smtp.gmail.com');
      expect(change.from.password).toBe('(unset)');
      expect(change.to.password).toBe('env(SMTP_PASSWORD)');
      expect(change.passwordEnvRef).toBe('SMTP_PASSWORD');
    }
  });

  it('treats absent [auth.smtp] section as no-op (preserve live)', () => {
    const live = { auth: { smtp: LIVE_SMTP_CONFIGURED } };
    const file = { auth: {} };
    expect(diffConfig({ live, file }).changes).toEqual([]);
  });

  it('force-resends password when env() ref is present even if other fields match', () => {
    const live = { auth: { smtp: LIVE_SMTP_CONFIGURED } };
    const file = {
      auth: {
        smtp: {
          enabled: true,
          host: 'smtp.gmail.com',
          port: 587,
          username: 'user@gmail.com',
          password: 'env(SMTP_PASSWORD)',
          sender_email: 'noreply@app.com',
          sender_name: 'App',
          min_interval_seconds: 60,
        },
      },
    };
    const result = diffConfig({ live, file });
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0];
    if (change.section === 'auth.smtp') {
      expect(change.passwordEnvRef).toBe('SMTP_PASSWORD');
      expect(change.from.host).toBe(change.to.host);
    }
  });

  it('is a true no-op when password is omitted and non-password fields match', () => {
    const live = { auth: { smtp: LIVE_SMTP_CONFIGURED } };
    const file = {
      auth: {
        smtp: {
          enabled: true,
          host: 'smtp.gmail.com',
          port: 587,
          username: 'user@gmail.com',
          sender_email: 'noreply@app.com',
          sender_name: 'App',
          min_interval_seconds: 60,
        },
      },
    };
    expect(diffConfig({ live, file }).changes).toEqual([]);
  });

  it('renders password slot as "(set)" for live and "(unchanged)" for file omission', () => {
    const live = { auth: { smtp: LIVE_SMTP_CONFIGURED } };
    const file = {
      auth: {
        smtp: {
          enabled: false,
          host: 'smtp.gmail.com',
          port: 587,
          username: 'user@gmail.com',
          sender_email: 'noreply@app.com',
          sender_name: 'App',
          min_interval_seconds: 60,
        },
      },
    };
    const result = diffConfig({ live, file });
    const change = result.changes[0];
    if (change.section === 'auth.smtp') {
      expect(change.from.password).toBe('(set)');
      expect(change.to.password).toBe('(unchanged)');
      expect(change.passwordEnvRef).toBeUndefined();
    }
  });

  it('diffs SMTP and redirect URLs independently in one apply batch', () => {
    const live = {
      auth: {
        allowed_redirect_urls: ['https://old.com'],
        smtp: LIVE_SMTP_EMPTY,
      },
    };
    const file = {
      auth: {
        allowed_redirect_urls: ['https://new.com'],
        smtp: { enabled: true, host: 'smtp.gmail.com' },
      },
    };
    const result = diffConfig({ live, file });
    expect(result.changes).toHaveLength(2);
    const sections = result.changes.map((c) => c.section).sort();
    expect(sections).toEqual(['auth', 'auth.smtp']);
  });
});

describe('diffConfig — auth verification flags', () => {
  it('emits a single change when require_email_verification flips', () => {
    const result = diffConfig({
      live: { auth: { require_email_verification: false } },
      file: { auth: { require_email_verification: true } },
    });
    expect(result.changes).toEqual([
      {
        section: 'auth',
        op: 'modify',
        key: 'require_email_verification',
        from: false,
        to: true,
      },
    ]);
  });

  it('treats absent live as default false for require_email_verification', () => {
    // Legacy backend that didn't expose the field — diff fills in the
    // documented default so the change "shows up" sensibly on first apply.
    const result = diffConfig({
      live: { auth: {} },
      file: { auth: { require_email_verification: true } },
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      key: 'require_email_verification',
      from: false,
      to: true,
    });
  });

  it('treats matching require_email_verification as no-op', () => {
    expect(
      diffConfig({
        live: { auth: { require_email_verification: true } },
        file: { auth: { require_email_verification: true } },
      }).changes,
    ).toEqual([]);
  });

  it('emits one change per verify/reset method swap', () => {
    const result = diffConfig({
      live: {
        auth: { verify_email_method: 'code', reset_password_method: 'code' },
      },
      file: {
        auth: { verify_email_method: 'link', reset_password_method: 'link' },
      },
    });
    expect(result.changes.map((c) => c.key).sort()).toEqual([
      'reset_password_method',
      'verify_email_method',
    ]);
  });

  it('treats absent live verify_email_method as default "code"', () => {
    expect(
      diffConfig({
        live: { auth: {} },
        file: { auth: { verify_email_method: 'code' } },
      }).changes,
    ).toEqual([]);
  });

  it('emits a change when disable_signup flips', () => {
    expect(
      diffConfig({
        live: { auth: { disable_signup: false } },
        file: { auth: { disable_signup: true } },
      }).changes,
    ).toEqual([
      {
        section: 'auth',
        op: 'modify',
        key: 'disable_signup',
        from: false,
        to: true,
      },
    ]);
  });
});

describe('diffConfig — [auth.password]', () => {
  const LIVE_POLICY = {
    min_length: 8,
    require_number: false,
    require_lowercase: false,
    require_uppercase: false,
    require_special_char: false,
  };

  it('emits per-field changes when policy fields differ', () => {
    const result = diffConfig({
      live: { auth: { password: LIVE_POLICY } },
      file: {
        auth: {
          password: { min_length: 12, require_number: true },
        },
      },
    });
    expect(result.changes).toHaveLength(2);
    expect(result.changes.map((c) => c.key).sort()).toEqual([
      'min_length',
      'require_number',
    ]);
    for (const c of result.changes) {
      expect(c.section).toBe('auth.password');
    }
  });

  it('treats matching policy fields as no-op', () => {
    expect(
      diffConfig({
        live: { auth: { password: LIVE_POLICY } },
        file: { auth: { password: { min_length: 8, require_number: false } } },
      }).changes,
    ).toEqual([]);
  });

  it('preserves unspecified password fields (default-keep)', () => {
    // file changes min_length only; the require_* flags should not appear
    // as diff entries even though their live values differ from the file's
    // omitted defaults.
    const result = diffConfig({
      live: {
        auth: {
          password: {
            min_length: 8,
            require_number: true,
            require_lowercase: true,
            require_uppercase: true,
            require_special_char: true,
          },
        },
      },
      file: { auth: { password: { min_length: 16 } } },
    });
    expect(result.changes).toEqual([
      {
        section: 'auth.password',
        op: 'modify',
        key: 'min_length',
        from: 8,
        to: 16,
      },
    ]);
  });

  it('falls back to backend defaults when live policy is missing', () => {
    // Legacy backend that didn't expose any policy fields.
    const result = diffConfig({
      live: { auth: {} },
      file: { auth: { password: { min_length: 12 } } },
    });
    expect(result.changes).toEqual([
      {
        section: 'auth.password',
        op: 'modify',
        key: 'min_length',
        from: 8,
        to: 12,
      },
    ]);
  });
});

describe('diffConfig — additional config sections', () => {
  it('diffs storage max file size', () => {
    expect(
      diffConfig({
        live: { storage: { max_file_size_mb: 50 } },
        file: { storage: { max_file_size_mb: 100 } },
      }).changes,
    ).toEqual([
      {
        section: 'storage',
        op: 'modify',
        key: 'max_file_size_mb',
        from: 50,
        to: 100,
      },
    ]);
  });

  it('normalizes retention_days = 0 to backend null', () => {
    expect(
      diffConfig({
        live: { realtime: { retention_days: 7 } },
        file: { realtime: { retention_days: 0 } },
      }).changes,
    ).toEqual([
      {
        section: 'realtime',
        op: 'modify',
        key: 'retention_days',
        from: 7,
        to: null,
      },
    ]);
  });

  it('diffs schedules retention independently', () => {
    expect(
      diffConfig({
        live: { schedules: { retention_days: null } },
        file: { schedules: { retention_days: 14 } },
      }).changes,
    ).toEqual([
      {
        section: 'schedules',
        op: 'modify',
        key: 'retention_days',
        from: null,
        to: 14,
      },
    ]);
  });

  it('diffs auth email templates by template type', () => {
    expect(
      diffConfig({
        live: {
          auth: {
            email_templates: {
              'reset-password-link': {
                subject: 'Old',
                body_html: '<p>Old</p>',
              },
            },
          },
        },
        file: {
          auth: {
            email_templates: {
              'reset-password-link': {
                subject: 'New',
                body_html: '<p>New</p>',
              },
            },
          },
        },
      }).changes,
    ).toEqual([
      {
        section: 'auth.email_templates',
        op: 'modify',
        key: 'reset-password-link',
        from: { subject: 'Old', body_html: '<p>Old</p>' },
        to: { subject: 'New', body_html: '<p>New</p>' },
      },
    ]);
  });
});
