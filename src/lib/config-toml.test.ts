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

  it('rejects port outside 1-65535', () => {
    expect(() => parseConfigToml('[auth.smtp]\nport = 0\n')).toThrow(
      /port.*1 and 65535/,
    );
    expect(() => parseConfigToml('[auth.smtp]\nport = -1\n')).toThrow(
      /port.*1 and 65535/,
    );
    expect(() => parseConfigToml('[auth.smtp]\nport = 70000\n')).toThrow(
      /port.*1 and 65535/,
    );
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

  it('discovery comment names the actual env ref, not the SMTP_PASSWORD default', () => {
    // When the user names their secret PROD_SMTP_PASS, the hint that tells
    // them how to provision it must point at PROD_SMTP_PASS — pointing at
    // SMTP_PASSWORD would have them create the wrong secret.
    const out = stringifyConfigToml({
      auth: {
        smtp: {
          password: 'env(PROD_SMTP_PASS)',
        },
      },
    });
    expect(out).toContain('insforge secrets add PROD_SMTP_PASS');
    expect(out).not.toContain('insforge secrets add SMTP_PASSWORD');
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

describe('parseConfigToml — auth verification flags', () => {
  it('parses require_email_verification as a boolean', () => {
    const toml = `
[auth]
require_email_verification = true
`;
    expect(parseConfigToml(toml)).toEqual({
      auth: { require_email_verification: true },
    });
  });

  it('rejects non-boolean require_email_verification', () => {
    expect(() =>
      parseConfigToml('[auth]\nrequire_email_verification = "yes"\n'),
    ).toThrow(/require_email_verification.*boolean/);
  });

  it('parses verify_email_method as "code" or "link"', () => {
    expect(parseConfigToml('[auth]\nverify_email_method = "code"\n')).toEqual({
      auth: { verify_email_method: 'code' },
    });
    expect(parseConfigToml('[auth]\nverify_email_method = "link"\n')).toEqual({
      auth: { verify_email_method: 'link' },
    });
  });

  it('rejects unknown verify_email_method value', () => {
    expect(() =>
      parseConfigToml('[auth]\nverify_email_method = "magic"\n'),
    ).toThrow(/verify_email_method.*code.*link/);
  });

  it('parses reset_password_method as "code" or "link"', () => {
    expect(
      parseConfigToml('[auth]\nreset_password_method = "link"\n'),
    ).toEqual({ auth: { reset_password_method: 'link' } });
  });

  it('parses disable_signup as a boolean', () => {
    expect(parseConfigToml('[auth]\ndisable_signup = true\n')).toEqual({
      auth: { disable_signup: true },
    });
  });
});

describe('parseConfigToml — [auth.password]', () => {
  it('parses a full password policy', () => {
    const toml = `
[auth.password]
min_length = 12
require_number = true
require_lowercase = true
require_uppercase = false
require_special_char = true
`;
    expect(parseConfigToml(toml)).toEqual({
      auth: {
        password: {
          min_length: 12,
          require_number: true,
          require_lowercase: true,
          require_uppercase: false,
          require_special_char: true,
        },
      },
    });
  });

  it('accepts a partial policy (default-keep semantics)', () => {
    expect(parseConfigToml('[auth.password]\nmin_length = 16\n')).toEqual({
      auth: { password: { min_length: 16 } },
    });
  });

  it('rejects min_length below 4', () => {
    expect(() =>
      parseConfigToml('[auth.password]\nmin_length = 3\n'),
    ).toThrow(/min_length.*4 and 128/);
  });

  it('rejects min_length above 128', () => {
    expect(() =>
      parseConfigToml('[auth.password]\nmin_length = 200\n'),
    ).toThrow(/min_length.*4 and 128/);
  });

  it('rejects non-integer min_length', () => {
    expect(() =>
      parseConfigToml('[auth.password]\nmin_length = 8.5\n'),
    ).toThrow(/min_length.*4 and 128/);
  });

  it('rejects non-boolean require_* field', () => {
    expect(() =>
      parseConfigToml('[auth.password]\nrequire_number = "yes"\n'),
    ).toThrow(/auth\.password\.require_number.*boolean/);
  });
});

describe('parseConfigToml — additional config sections', () => {
  it('parses storage, retention, and auth email template sections', () => {
    const toml = `
[storage]
max_file_size_mb = 100

[realtime]
retention_days = 0

[schedules]
retention_days = 30

[auth.email_templates."reset-password-link"]
subject = "Reset your password"
body_html = "<p>Click {{ .ConfirmationURL }}</p>"
`;
    expect(parseConfigToml(toml)).toEqual({
      storage: { max_file_size_mb: 100 },
      realtime: { retention_days: 0 },
      schedules: { retention_days: 30 },
      auth: {
        email_templates: {
          'reset-password-link': {
            subject: 'Reset your password',
            body_html: '<p>Click {{ .ConfirmationURL }}</p>',
          },
        },
      },
    });
  });

  it('rejects an unknown email template type', () => {
    expect(() =>
      parseConfigToml(
        '[auth.email_templates."welcome"]\nsubject = "Hi"\nbody_html = "<p>Hi</p>"\n',
      ),
    ).toThrow(/auth\.email_templates\.welcome.*must be one of/);
  });

  it('rejects invalid storage and retention values', () => {
    expect(() => parseConfigToml('[storage]\nmax_file_size_mb = 201\n')).toThrow(
      /max_file_size_mb.*1 and 200/,
    );
    expect(() => parseConfigToml('[realtime]\nretention_days = -1\n')).toThrow(
      /retention_days.*non-negative/,
    );
  });
});

describe('stringifyConfigToml — additional config sections', () => {
  it('emits new sections in a round-trippable TOML shape', () => {
    const original = {
      auth: {
        disable_signup: true,
        email_templates: {
          'email-verification-code': {
            subject: 'Verify',
            body_html: '<p>{{ .Token }}</p>',
          },
        },
      },
      storage: { max_file_size_mb: 100 },
      realtime: { retention_days: 0 },
      schedules: { retention_days: 30 },
    };
    const out = stringifyConfigToml(original);
    expect(out).toContain('disable_signup = true');
    expect(out).toContain('[auth.email_templates."email-verification-code"]');
    expect(out).toContain('[storage]');
    expect(out).toContain('[realtime]');
    expect(out).toContain('[schedules]');
    expect(parseConfigToml(out)).toEqual(original);
  });

  it('renders null retention as retention_days = 0', () => {
    const out = stringifyConfigToml({ realtime: { retention_days: null } });
    expect(out).toContain('retention_days = 0');
  });
});

describe('stringifyConfigToml — auth flags + password', () => {
  it('emits the three auth flags directly under [auth]', () => {
    const out = stringifyConfigToml({
      auth: {
        require_email_verification: true,
        verify_email_method: 'link',
        reset_password_method: 'code',
      },
    });
    expect(out).toContain('[auth]');
    expect(out).toContain('require_email_verification = true');
    expect(out).toContain('verify_email_method = "link"');
    expect(out).toContain('reset_password_method = "code"');
  });

  it('emits [auth.password] as a sub-table after [auth]', () => {
    const out = stringifyConfigToml({
      auth: {
        require_email_verification: true,
        password: {
          min_length: 12,
          require_number: true,
        },
      },
    });
    const authIdx = out.indexOf('[auth]');
    const pwIdx = out.indexOf('[auth.password]');
    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(pwIdx).toBeGreaterThan(authIdx);
    expect(out).toContain('min_length = 12');
    expect(out).toContain('require_number = true');
  });

  it('omits unspecified password fields (preserves partial policy)', () => {
    const out = stringifyConfigToml({
      auth: { password: { min_length: 8 } },
    });
    expect(out).toContain('[auth.password]');
    expect(out).toContain('min_length = 8');
    expect(out).not.toContain('require_number');
  });

  it('round-trips a full auth + password config', () => {
    const original = {
      auth: {
        allowed_redirect_urls: ['https://a.com'],
        require_email_verification: true,
        verify_email_method: 'link' as const,
        reset_password_method: 'code' as const,
        password: {
          min_length: 12,
          require_number: true,
          require_lowercase: true,
          require_uppercase: true,
          require_special_char: true,
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
