import { describe, expect, it } from 'vitest';
import { parseEnvRef, validateSensitiveString } from './config-secrets.js';
import { ConfigValidationError } from './config-schema.js';

describe('parseEnvRef', () => {
  it('extracts the secret name from a well-formed env() reference', () => {
    expect(parseEnvRef('env(GOOGLE_CLIENT_SECRET)')).toBe('GOOGLE_CLIENT_SECRET');
    expect(parseEnvRef('env(SMTP_PASSWORD)')).toBe('SMTP_PASSWORD');
    expect(parseEnvRef('env(_INTERNAL)')).toBe('_INTERNAL');
  });

  it('returns null for literal values', () => {
    expect(parseEnvRef('actual-secret-123')).toBeNull();
    expect(parseEnvRef('')).toBeNull();
    expect(parseEnvRef('env(lower_case)')).toBeNull();
    expect(parseEnvRef('env(WITH SPACE)')).toBeNull();
    expect(parseEnvRef('env()')).toBeNull();
    expect(parseEnvRef('something env(GOOD)')).toBeNull();
    expect(parseEnvRef('env(GOOD) and more')).toBeNull();
  });
});

describe('validateSensitiveString', () => {
  it('accepts well-formed env() references', () => {
    expect(
      validateSensitiveString(
        'email.smtp.password',
        'env(SMTP_PASSWORD)',
        'SMTP_PASSWORD',
      ),
    ).toBe('env(SMTP_PASSWORD)');
  });

  it('rejects literal values with an actionable error', () => {
    let caught: ConfigValidationError | null = null;
    try {
      validateSensitiveString(
        'email.smtp.password',
        'MyActualPassword',
        'SMTP_PASSWORD',
      );
    } catch (err) {
      caught = err as ConfigValidationError;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.path).toBe('email.smtp.password');
    expect(caught!.message).toContain('sensitive field must be an env() reference');
    expect(caught!.message).toContain('insforge secrets add SMTP_PASSWORD');
    expect(caught!.message).toContain('password = "env(SMTP_PASSWORD)"');
  });

  it('rejects malformed env() references (lowercase, empty, etc.)', () => {
    expect(() =>
      validateSensitiveString('x.y', 'env(lower_case)', 'GOOD_NAME'),
    ).toThrow(ConfigValidationError);
    expect(() => validateSensitiveString('x.y', 'env()', 'GOOD_NAME')).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects non-string values', () => {
    expect(() => validateSensitiveString('x.y', 123, 'GOOD_NAME')).toThrow(
      /must be a string/,
    );
    expect(() => validateSensitiveString('x.y', null, 'GOOD_NAME')).toThrow(
      /must be a string/,
    );
    expect(() =>
      validateSensitiveString('x.y', undefined, 'GOOD_NAME'),
    ).toThrow(/must be a string/);
  });
});
