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
