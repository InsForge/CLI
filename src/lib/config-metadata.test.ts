import { describe, expect, it } from 'vitest';
import { configFromMetadata, liveFromMetadata } from './config-metadata.js';

describe('liveFromMetadata', () => {
  it('projects a full backend response onto LiveConfig', () => {
    const live = liveFromMetadata({
      auth: {
        allowedRedirectUrls: ['https://a.com'],
        requireEmailVerification: true,
        verifyEmailMethod: 'link',
        resetPasswordMethod: 'code',
        passwordMinLength: 12,
        requireNumber: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSpecialChar: false,
        smtpConfig: {
          enabled: true,
          host: 'smtp.gmail.com',
          port: 587,
          username: 'u',
          hasPassword: true,
          senderEmail: 's@a.com',
          senderName: 'A',
          minIntervalSeconds: 60,
        },
      },
      deployments: { customSlug: 'my-app' },
    });
    expect(live).toEqual({
      auth: {
        allowed_redirect_urls: ['https://a.com'],
        require_email_verification: true,
        verify_email_method: 'link',
        reset_password_method: 'code',
        password: {
          min_length: 12,
          require_number: true,
          require_lowercase: true,
          require_uppercase: true,
          require_special_char: false,
        },
        smtp: {
          enabled: true,
          host: 'smtp.gmail.com',
          port: 587,
          username: 'u',
          hasPassword: true,
          sender_email: 's@a.com',
          sender_name: 'A',
          min_interval_seconds: 60,
        },
      },
      deployments: { subdomain: 'my-app' },
    });
  });

  it('returns an empty auth slice when backend exposes no auth fields', () => {
    // Legacy backend / freshly-migrated project: presence-based detection
    // must NOT invent fields. The diff layer fills in safe defaults for
    // anything the file references; live stays empty.
    expect(liveFromMetadata({ auth: {} })).toEqual({ auth: {} });
    expect(liveFromMetadata({})).toEqual({ auth: {} });
  });

  it('builds a partial password block when backend exposes some but not all fields', () => {
    const live = liveFromMetadata({
      auth: { passwordMinLength: 16, requireNumber: true },
    });
    // Fields not exposed by the backend take the documented defaults so the
    // diff layer can still compare against a coherent live view.
    expect(live.auth?.password).toEqual({
      min_length: 16,
      require_number: true,
      require_lowercase: false,
      require_uppercase: false,
      require_special_char: false,
    });
  });

  it('drops unknown enum values silently', () => {
    // A future backend value (e.g. 'otp') would fail the parser if echoed
    // back into TOML, so we treat it as absent. The diff layer then
    // defaults live to 'code' — see diffConfig for the rationale.
    const live = liveFromMetadata({
      auth: { verifyEmailMethod: 'otp' },
    });
    expect(live.auth?.verify_email_method).toBeUndefined();
  });

  it('omits deployments when slice is absent (self-host)', () => {
    expect(liveFromMetadata({ auth: { allowedRedirectUrls: [] } }).deployments).toBeUndefined();
  });

  it('treats a malformed auth slice as absent rather than crashing', () => {
    // A server returning auth: "oops" or auth: 42 must not crash `config plan`
    // — `'key' in primitive` throws a TypeError. Treat any non-object slice as
    // "this backend exposes nothing" so the command degrades gracefully.
    for (const bad of ['oops', 42, true, [], null] as unknown[]) {
      const live = liveFromMetadata({ auth: bad as never });
      expect(live).toEqual({ auth: {} });
    }
  });

  it('coerces non-array allowedRedirectUrls to [] rather than crashing diff/render', () => {
    // Belt-and-braces: even with a typed RawAuthMetadata, a malformed
    // payload could ship a string here. `normalizeUrlList` would throw on
    // `.sort()` over a string, so coerce safely.
    const live = liveFromMetadata({
      auth: { allowedRedirectUrls: 'https://oops.com' as unknown as string[] },
    });
    expect(live.auth?.allowed_redirect_urls).toEqual([]);
  });

  it('omits live.smtp when backend returns smtpConfig: null', () => {
    // null = "SMTP is supported but no row yet". The diff layer fills the
    // empty-state defaults; live.smtp stays undefined to signal that.
    const live = liveFromMetadata({ auth: { smtpConfig: null as never } });
    expect(live.auth?.smtp).toBeUndefined();
  });
});

describe('configFromMetadata', () => {
  it('projects a full backend response onto InsforgeConfig with no skipped entries', () => {
    const { config, skipped } = configFromMetadata({
      auth: {
        allowedRedirectUrls: ['https://a.com'],
        requireEmailVerification: true,
        verifyEmailMethod: 'link',
        resetPasswordMethod: 'code',
        passwordMinLength: 12,
        requireNumber: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSpecialChar: false,
        smtpConfig: {
          enabled: false,
          host: '',
          port: 587,
          username: '',
          hasPassword: false,
          senderEmail: '',
          senderName: '',
          minIntervalSeconds: 60,
        },
      },
      deployments: { customSlug: 'my-app' },
    });
    expect(config.auth?.require_email_verification).toBe(true);
    expect(config.auth?.verify_email_method).toBe('link');
    expect(config.auth?.password).toEqual({
      min_length: 12,
      require_number: true,
      require_lowercase: true,
      require_uppercase: true,
      require_special_char: false,
    });
    expect(config.auth?.smtp).toBeDefined();
    expect(config.deployments).toEqual({ subdomain: 'my-app' });
    expect(skipped).toEqual([]);
  });

  it('reports every unsupported field for a legacy backend', () => {
    const { config, skipped } = configFromMetadata({ auth: {} });
    expect(config.auth).toBeUndefined();
    expect(skipped.sort()).toEqual([
      'auth.allowed_redirect_urls',
      'auth.password',
      'auth.require_email_verification',
      'auth.reset_password_method',
      'auth.smtp',
      'auth.verify_email_method',
      'deployments.subdomain',
    ]);
  });

  it('emits only the password fields the backend exposes', () => {
    // Backend ships passwordMinLength but not the require_* flags — the TOML
    // should show only min_length so re-applying is a no-op for the rest.
    const { config } = configFromMetadata({
      auth: { passwordMinLength: 16 },
    });
    expect(config.auth?.password).toEqual({ min_length: 16 });
  });

  it('drops unknown enum values and lists them as skipped', () => {
    const { config, skipped } = configFromMetadata({
      auth: { verifyEmailMethod: 'otp' },
    });
    expect(config.auth?.verify_email_method).toBeUndefined();
    expect(skipped).toContain('auth.verify_email_method');
  });

  it('omits [deployments] when slug is unset on cloud backend', () => {
    // customSlug: null means "default URL" — emitting subdomain = "" would
    // mean "clear on apply" which fails the 3-char min on the backend.
    const { config } = configFromMetadata({
      auth: { allowedRedirectUrls: [] },
      deployments: { customSlug: null },
    });
    expect(config.deployments).toBeUndefined();
  });

  it('treats a malformed auth slice as absent and reports every field skipped', () => {
    for (const bad of ['oops', 42, true, [], null] as unknown[]) {
      const { config, skipped } = configFromMetadata({ auth: bad as never });
      expect(config.auth).toBeUndefined();
      expect(skipped).toContain('auth.allowed_redirect_urls');
      expect(skipped).toContain('auth.password');
    }
  });

  it('falls back to [] when allowedRedirectUrls is wrong-shaped (still supported)', () => {
    const { config, skipped } = configFromMetadata({
      auth: { allowedRedirectUrls: 'https://oops.com' as unknown as string[] },
    });
    expect(config.auth?.allowed_redirect_urls).toEqual([]);
    // Field is still considered supported — backend exposed the key, just
    // with a malformed value. Skipping it would hide the bug from the user.
    expect(skipped).not.toContain('auth.allowed_redirect_urls');
  });

  it('treats smtpConfig: null as supported-but-empty (no [auth.smtp] block, NOT in skipped)', () => {
    // Presence-based capability gating: the key exists in the response, so
    // the backend supports SMTP — there's just no row yet. Marking it as
    // skipped would tell the user "your backend doesn't support SMTP" which
    // is false. Matches metadataSupports() in config-capabilities.ts.
    const { config, skipped } = configFromMetadata({
      auth: { smtpConfig: null as never },
    });
    expect(config.auth?.smtp).toBeUndefined();
    expect(skipped).not.toContain('auth.smtp');
  });

  it('emits env(SMTP_PASSWORD) placeholder when hasPassword is true', () => {
    const { config } = configFromMetadata({
      auth: {
        smtpConfig: {
          enabled: true,
          host: 'smtp.gmail.com',
          port: 587,
          username: 'u',
          hasPassword: true,
          senderEmail: 's@a.com',
          senderName: 'A',
          minIntervalSeconds: 60,
        },
      },
    });
    expect(config.auth?.smtp?.password).toBe('env(SMTP_PASSWORD)');
  });
});
