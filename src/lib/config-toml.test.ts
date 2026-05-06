// CLI/src/lib/config-toml.test.ts
import { describe, expect, it } from 'vitest';
import { parseConfigToml, stringifyConfigToml } from './config-toml.js';

describe('parseConfigToml', () => {
  it('parses MVP fields end-to-end', () => {
    const toml = `
project_id = "proj-abc"

[auth]
jwt_expiry = 3600
enable_signup = true
site_url = "https://app.example.com"
additional_redirect_urls = ["http://localhost:3000"]

[storage.buckets.avatars]
public = true

[storage.buckets.user-files]
public = false
`;
    expect(parseConfigToml(toml)).toEqual({
      project_id: 'proj-abc',
      auth: {
        jwt_expiry: 3600,
        enable_signup: true,
        site_url: 'https://app.example.com',
        additional_redirect_urls: ['http://localhost:3000'],
      },
      storage: {
        buckets: {
          avatars: { public: true },
          'user-files': { public: false },
        },
      },
    });
  });

  it('throws ConfigValidationError on bad type', () => {
    expect(() => parseConfigToml('[auth]\njwt_expiry = "60m"')).toThrow(/jwt_expiry.*positive integer/);
  });

  it('throws on malformed TOML with a clear message', () => {
    expect(() => parseConfigToml('[auth\nbroken')).toThrow(/TOML parse error/);
  });
});

describe('stringifyConfigToml', () => {
  it('round-trips a config through stringify → parse', () => {
    const original = {
      project_id: 'proj-abc',
      auth: { jwt_expiry: 3600, enable_signup: false },
      storage: { buckets: { avatars: { public: true } } },
    };
    expect(parseConfigToml(stringifyConfigToml(original))).toEqual(original);
  });

  it('emits stable, predictable section ordering', () => {
    const out = stringifyConfigToml({
      storage: { buckets: { z: { public: true }, a: { public: false } } },
      auth: { enable_signup: true },
      project_id: 'proj-x',
    });
    // project_id first, then auth, then storage; bucket keys sorted
    expect(out.indexOf('project_id')).toBeLessThan(out.indexOf('[auth]'));
    expect(out.indexOf('[auth]')).toBeLessThan(out.indexOf('[storage.buckets.a]'));
    expect(out.indexOf('[storage.buckets.a]')).toBeLessThan(out.indexOf('[storage.buckets.z]'));
  });
});
