import { describe, it, expect } from 'vitest';
import { isPatLogin } from './credentials.js';
import type { StoredCredentials } from '../types.js';

describe('isPatLogin', () => {
  const base = (refresh_token: string): StoredCredentials => ({
    access_token: 'jwt',
    refresh_token,
    user: {} as unknown as StoredCredentials['user'],
  });

  it('returns true when refresh_token starts with uak_', () => {
    expect(isPatLogin(base('uak_abc'))).toBe(true);
  });

  it('returns false for OAuth refresh tokens', () => {
    expect(isPatLogin(base('some-oauth-refresh-token'))).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isPatLogin(null)).toBe(false);
    expect(isPatLogin(undefined)).toBe(false);
  });

  it('returns false when refresh_token is empty', () => {
    expect(isPatLogin(base(''))).toBe(false);
  });
});
