import { describe, expect, it } from 'vitest';
import { parseConfigToml, stringifyConfigToml } from './config-toml.js';

describe('parseConfigToml', () => {
  it('parses MVP fields end-to-end', () => {
    const toml = `
project_id = "proj-abc"

[auth]
allowed_redirect_urls = ["https://app.example.com", "http://localhost:3000"]
`;
    expect(parseConfigToml(toml)).toEqual({
      project_id: 'proj-abc',
      auth: {
        allowed_redirect_urls: ['https://app.example.com', 'http://localhost:3000'],
      },
    });
  });

  it('throws ConfigValidationError on bad type', () => {
    expect(() =>
      parseConfigToml('[auth]\nallowed_redirect_urls = "not-an-array"'),
    ).toThrow(/allowed_redirect_urls.*array of strings/);
  });

  it('throws on malformed TOML with a clear message', () => {
    expect(() => parseConfigToml('[auth\nbroken')).toThrow(/TOML parse error/);
  });

  it('accepts an empty config', () => {
    expect(parseConfigToml('')).toEqual({});
  });
});

describe('stringifyConfigToml', () => {
  it('round-trips a config through stringify → parse', () => {
    const original = {
      project_id: 'proj-abc',
      auth: { allowed_redirect_urls: ['https://a.com', 'http://localhost:3000'] },
    };
    expect(parseConfigToml(stringifyConfigToml(original))).toEqual(original);
  });

  it('omits sections that are undefined', () => {
    const out = stringifyConfigToml({ project_id: 'proj-x' });
    expect(out).toContain('project_id');
    expect(out).not.toContain('[auth]');
  });
});

describe('parseConfigToml — auth.smtp', () => {
  it('parses a full SMTP section with env() password ref', () => {
    const toml = `
[auth.smtp]
enabled = true
host = "smtp.gmail.com"
port = 587
username = "user@gmail.com"
password = "env(SMTP_PASSWORD)"
sender_email = "noreply@app.com"
sender_name = "App"
min_interval_seconds = 60
`;
    expect(parseConfigToml(toml)).toEqual({
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
    });
  });

  it('rejects a literal password (must be env() ref)', () => {
    const toml = `
[auth.smtp]
password = "plaintext-secret-do-not-commit"
`;
    expect(() => parseConfigToml(toml)).toThrow(/sensitive field must be an env\(\) reference/);
  });

  it('accepts SMTP section with only some fields (partial)', () => {
    const toml = `
[auth.smtp]
enabled = false
`;
    expect(parseConfigToml(toml)).toEqual({
      auth: { smtp: { enabled: false } },
    });
  });

  it('rejects invalid SMTP port (non-integer)', () => {
    const toml = `
[auth.smtp]
port = 587.5
`;
    expect(() => parseConfigToml(toml)).toThrow(/auth\.smtp\.port.*integer/);
  });

  it('rejects negative min_interval_seconds', () => {
    const toml = `
[auth.smtp]
min_interval_seconds = -1
`;
    expect(() => parseConfigToml(toml)).toThrow(/min_interval_seconds.*non-negative/);
  });
});

describe('stringifyConfigToml — auth.smtp', () => {
  it('emits SMTP fields under [auth.smtp] with discovery comment for password', () => {
    const out = stringifyConfigToml({
      auth: {
        smtp: {
          enabled: true,
          host: 'smtp.gmail.com',
          port: 587,
          username: 'u@g.com',
          password: 'env(SMTP_PASSWORD)',
          sender_email: 'noreply@a.com',
          sender_name: 'App',
          min_interval_seconds: 60,
        },
      },
    });
    expect(out).toContain('[auth.smtp]');
    expect(out).toContain('password = "env(SMTP_PASSWORD)"');
    expect(out).toContain('insforge secrets add SMTP_PASSWORD');
  });

  it('omits password line entirely when password is undefined', () => {
    const out = stringifyConfigToml({
      auth: {
        smtp: {
          enabled: false,
          host: '',
          port: 587,
          username: '',
          sender_email: '',
          sender_name: '',
          min_interval_seconds: 60,
        },
      },
    });
    expect(out).toContain('[auth.smtp]');
    expect(out).not.toContain('password');
  });

  it('round-trips a full SMTP config through stringify → parse', () => {
    const original = {
      auth: {
        smtp: {
          enabled: true,
          host: 'smtp.gmail.com',
          port: 587,
          username: 'u@g.com',
          password: 'env(SMTP_PASSWORD)',
          sender_email: 'noreply@a.com',
          sender_name: 'App',
          min_interval_seconds: 60,
        },
      },
    };
    expect(parseConfigToml(stringifyConfigToml(original))).toEqual(original);
  });
});

describe('parseConfigToml — [deployments]', () => {
  it('parses subdomain as a string', () => {
    expect(parseConfigToml('[deployments]\nsubdomain = "my-app"\n')).toEqual({
      deployments: { subdomain: 'my-app' },
    });
  });

  it('parses empty subdomain (the clear-slug signal)', () => {
    // TOML has no null literal, so "" is the convention for "unset on apply".
    // The diff layer normalizes this to null before sending.
    expect(parseConfigToml('[deployments]\nsubdomain = ""\n')).toEqual({
      deployments: { subdomain: '' },
    });
  });

  it('rejects non-string subdomain', () => {
    expect(() => parseConfigToml('[deployments]\nsubdomain = 42\n')).toThrow(
      /subdomain.*string or null/,
    );
  });
});

describe('stringifyConfigToml — [deployments]', () => {
  it('emits [deployments] section when subdomain is a non-empty string', () => {
    const out = stringifyConfigToml({ deployments: { subdomain: 'my-app' } });
    expect(out).toContain('[deployments]');
    expect(out).toContain('subdomain = "my-app"');
  });

  it('omits the section when subdomain is null', () => {
    const out = stringifyConfigToml({ deployments: { subdomain: null } });
    expect(out).not.toContain('[deployments]');
  });

  it('omits the section when subdomain is empty string (avoid emitting clear-signal in export)', () => {
    const out = stringifyConfigToml({ deployments: { subdomain: '' } });
    expect(out).not.toContain('[deployments]');
  });
});
