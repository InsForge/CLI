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
