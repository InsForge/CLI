import { describe, it, expect } from 'vitest';
import { redactSensitive, truncateMiddle } from './redact.js';

describe('redactSensitive', () => {
  it('redacts emails', () => {
    expect(redactSensitive('user can.lyu@example.dev hit a 500')).toBe(
      'user [REDACTED_EMAIL] hit a 500',
    );
  });

  it('redacts JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpM';
    expect(redactSensitive(`token was ${jwt} in the header`)).toBe(
      'token was [REDACTED_JWT] in the header',
    );
  });

  it('redacts bearer tokens', () => {
    expect(redactSensitive('Authorization: Bearer abc123def456ghi')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('redacts known key formats', () => {
    expect(redactSensitive('used uak_a1b2c3d4e5f6 to auth')).toBe('used [REDACTED_KEY] to auth');
    // Short fixture on purpose: long enough for our redaction pattern (8+),
    // too short for GitHub push protection's Stripe detector (24+).
    expect(redactSensitive('sk_live_a1b2c3d4e5f6')).toBe('[REDACTED_KEY]');
    expect(redactSensitive('sk-proj-abcdefghijklmnop1234')).toBe('[REDACTED_KEY]');
    expect(redactSensitive('ghp_16C7e42F292c6912E7710c838347Ae178B4a')).toBe('[REDACTED_KEY]');
    expect(redactSensitive('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED_KEY]');
    expect(redactSensitive('xoxb-1234567890-abcdefg')).toBe('[REDACTED_KEY]');
  });

  it('redacts generic secret assignments but keeps the key name', () => {
    expect(redactSensitive('set password=hunter42! and retry')).toBe(
      'set password=[REDACTED] and retry',
    );
    expect(redactSensitive('config has api_key: "abc123xyz"')).toBe(
      'config has api_key: "[REDACTED]"',
    );
    expect(redactSensitive('ANON_TOKEN=abcdef123456')).toBe('ANON_TOKEN=[REDACTED]');
  });

  it('redacts credentials embedded in connection strings', () => {
    expect(redactSensitive('postgres://admin:s3cret@db.insforge.dev:5432/app')).toBe(
      'postgres://[REDACTED_CREDENTIALS]@db.insforge.dev:5432/app',
    );
  });

  it('rewrites home directories to ~', () => {
    expect(redactSensitive('read /Users/jane.doe/Documents/app/.env failed')).toBe(
      'read ~/Documents/app/.env failed',
    );
    expect(redactSensitive('read /home/jdoe/app/.env failed')).toBe('read ~/app/.env failed');
    expect(redactSensitive('read C:\\Users\\jdoe\\app\\.env failed')).toBe(
      'read ~\\app\\.env failed',
    );
  });

  it('redacts public IPs but keeps private/loopback ones', () => {
    expect(redactSensitive('connect to 8.8.8.8 failed')).toBe('connect to [REDACTED_IP] failed');
    expect(redactSensitive('listening on 127.0.0.1 and 192.168.1.5')).toBe(
      'listening on 127.0.0.1 and 192.168.1.5',
    );
    expect(redactSensitive('pod 10.0.3.17 unreachable')).toBe('pod 10.0.3.17 unreachable');
  });

  it('leaves version-like dotted numbers alone', () => {
    expect(redactSensitive('node 22.11.0 on darwin 25.2.0')).toBe('node 22.11.0 on darwin 25.2.0');
    // Four segments with an out-of-range octet is a version, not an IP
    expect(redactSensitive('chrome 131.0.6778.85')).toBe('chrome 131.0.6778.85');
  });

  it('leaves ordinary prose untouched', () => {
    const text =
      'insforge db policies create returns 500 when the table name contains uppercase letters';
    expect(redactSensitive(text)).toBe(text);
  });
});

describe('truncateMiddle', () => {
  it('returns short text unchanged', () => {
    expect(truncateMiddle('hello', 100)).toBe('hello');
  });

  it('keeps head and tail with a marker in between', () => {
    const text = 'A'.repeat(600) + 'MIDDLE' + 'Z'.repeat(600);
    const out = truncateMiddle(text, 100);
    expect(out.startsWith('A'.repeat(60))).toBe(true);
    expect(out.endsWith('Z'.repeat(40))).toBe(true);
    expect(out).toContain('chars truncated');
    expect(out).not.toContain('MIDDLE');
  });
});
