import { describe, it, expect } from 'vitest';
import { isPatLogin, isDirectApiKeyLogin } from './credentials.js';
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

  // A direct-API-key login stores the uak_ in user_api_key, NOT refresh_token,
  // so it must not be mistaken for an exchange-based PAT login (which would try
  // to re-exchange it against the deprecated endpoint).
  it('returns false for a direct-API-key login (uak_ in user_api_key, empty refresh_token)', () => {
    const creds: StoredCredentials = {
      access_token: '',
      refresh_token: '',
      user_api_key: 'uak_abc',
      user: {} as unknown as StoredCredentials['user'],
    };
    expect(isPatLogin(creds)).toBe(false);
  });
});

describe('isDirectApiKeyLogin', () => {
  const withApiKey = (user_api_key?: string): StoredCredentials => ({
    access_token: '',
    refresh_token: '',
    user_api_key,
    user: {} as unknown as StoredCredentials['user'],
  });

  it('returns true when user_api_key is set', () => {
    expect(isDirectApiKeyLogin(withApiKey('uak_abc'))).toBe(true);
  });

  it('returns false when user_api_key is absent', () => {
    expect(isDirectApiKeyLogin(withApiKey(undefined))).toBe(false);
  });

  it('returns false for exchange-PAT and OAuth logins', () => {
    expect(
      isDirectApiKeyLogin({
        access_token: 'jwt',
        refresh_token: 'uak_abc',
        user: {} as unknown as StoredCredentials['user'],
      })
    ).toBe(false);
    expect(
      isDirectApiKeyLogin({
        access_token: 'jwt',
        refresh_token: 'oauth-refresh',
        user: {} as unknown as StoredCredentials['user'],
      })
    ).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isDirectApiKeyLogin(null)).toBe(false);
    expect(isDirectApiKeyLogin(undefined)).toBe(false);
  });
});
