import { describe, expect, it, vi, beforeEach } from 'vitest';
import { parseEnvRef, validateSensitiveString, resolveEnvRef } from './config-secrets.js';
import { ConfigValidationError } from './config-schema.js';

const ossFetchMock = vi.fn();
vi.mock('./api/oss.js', () => ({
  ossFetch: (...args: unknown[]) => ossFetchMock(...args),
}));

beforeEach(() => {
  ossFetchMock.mockReset();
});

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

describe('resolveEnvRef', () => {
  it('returns the secret value on a successful lookup', async () => {
    ossFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: 'SMTP_PASSWORD', value: 'real-secret' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const value = await resolveEnvRef('env(SMTP_PASSWORD)', 'auth.smtp.password');
    expect(value).toBe('real-secret');
    expect(ossFetchMock).toHaveBeenCalledWith('/api/secrets/SMTP_PASSWORD');
  });

  it('throws SECRET_NOT_FOUND when secret is missing (ossFetch throws "not found")', async () => {
    // ossFetch throws on any non-2xx — recover the missing-secret signal from
    // the error message rather than inspecting status, since the underlying
    // Response is unreachable from the caller side.
    ossFetchMock.mockRejectedValueOnce(new Error('Secret not found: MISSING'));
    await expect(
      resolveEnvRef('env(MISSING)', 'auth.smtp.password'),
    ).rejects.toMatchObject({
      code: 'SECRET_NOT_FOUND',
      message: expect.stringContaining('insforge secrets add MISSING'),
    });
  });

  it('throws SECRET_EMPTY when the secret resolves to an empty string', async () => {
    ossFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ key: 'INACTIVE', value: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      resolveEnvRef('env(INACTIVE)', 'auth.smtp.password'),
    ).rejects.toMatchObject({
      code: 'SECRET_EMPTY',
      message: expect.stringContaining('insforge secrets update INACTIVE --active true'),
    });
  });

  it('throws SECRET_LOOKUP_FAILED on a non-404 HTTP error', async () => {
    ossFetchMock.mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    );
    await expect(
      resolveEnvRef('env(WHATEVER)', 'auth.smtp.password'),
    ).rejects.toMatchObject({ code: 'SECRET_LOOKUP_FAILED' });
  });

  it('throws ConfigValidationError if called with a non-env() string (defensive)', async () => {
    await expect(
      resolveEnvRef('plain-literal', 'auth.smtp.password'),
    ).rejects.toBeInstanceOf(ConfigValidationError);
  });
});
