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
