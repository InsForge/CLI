import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// GLOBAL_DIR in config.ts is derived from homedir() at import time, so the
// mock must be in place before auth.js/config.js are (dynamically) imported.
// Type-only imports are erased at compile time, so they don't evaluate the
// modules before the homedir mock is in place — the real imports are dynamic.
import type * as AuthModule from './auth.js';
import type * as ConfigModule from './config.js';
import type * as OsModule from 'node:os';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof OsModule>();
  return { ...actual, homedir: () => mocks.home || actual.homedir() };
});

let auth: typeof AuthModule;
let config: typeof ConfigModule;

beforeAll(async () => {
  mocks.home = mkdtempSync(join(tmpdir(), 'insforge-auth-test-'));
  auth = await import('./auth.js');
  config = await import('./config.js');
});

afterAll(() => {
  rmSync(mocks.home, { recursive: true, force: true });
});

beforeEach(() => {
  config.clearPendingLogin();
  vi.unstubAllGlobals();
});

describe('parseCallbackInput', () => {
  it('parses a full callback URL', () => {
    const result = auth.parseCallbackInput(
      'http://127.0.0.1:38961/callback?code=ac_abc123&state=st_xyz',
    );
    expect(result).toEqual({ code: 'ac_abc123', state: 'st_xyz' });
  });

  it('tolerates surrounding whitespace and quotes from copy-paste', () => {
    const result = auth.parseCallbackInput(
      '  "http://127.0.0.1:1234/callback?code=ac_a&state=s1"  ',
    );
    expect(result).toEqual({ code: 'ac_a', state: 's1' });
  });

  it('accepts a bare query string', () => {
    expect(auth.parseCallbackInput('?code=ac_a&state=s1')).toEqual({ code: 'ac_a', state: 's1' });
    expect(auth.parseCallbackInput('code=ac_a&state=s1')).toEqual({ code: 'ac_a', state: 's1' });
  });

  it('surfaces the provider error over a missing code', () => {
    expect(() =>
      auth.parseCallbackInput('http://127.0.0.1:1/callback?error=access_denied&error_description=User+denied'),
    ).toThrow(/denied/i);
  });

  it('rejects a bare code with guidance to paste the full URL', () => {
    expect(() => auth.parseCallbackInput('ac_abc123')).toThrow(/full callback URL/i);
  });

  it('rejects a URL missing state', () => {
    expect(() => auth.parseCallbackInput('http://127.0.0.1:1/callback?code=ac_a')).toThrow(/missing code or state/i);
  });
});

describe('startHeadlessOAuthLogin', () => {
  it('persists pending state and returns a matching authorize URL', () => {
    const { authUrl, redirectUri } = auth.startHeadlessOAuthLogin();
    const url = new URL(authUrl);

    expect(url.pathname).toBe('/api/oauth/v1/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const pending = config.getPendingLogin();
    expect(pending).not.toBeNull();
    expect(pending!.state).toBe(url.searchParams.get('state'));
    expect(pending!.redirect_uri).toBe(redirectUri);
    expect(pending!.code_verifier).toBeTruthy();
    // Loopback redirect, random port — the platform allows any 127.0.0.1 port.
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });
});

describe('completeHeadlessOAuthLogin', () => {
  function stubTokenAndProfileFetch() {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/oauth/v1/token')) {
        return new Response(
          JSON.stringify({ access_token: 'at_test', refresh_token: 'rt_test', expires_in: 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/auth/v1/profile')) {
        return new Response(
          JSON.stringify({ user: { id: 'u1', name: 'T', email: 't@x.dev', avatar_url: null, email_verified: true } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('fails with guidance when no login is pending', async () => {
    await expect(
      auth.completeHeadlessOAuthLogin('http://127.0.0.1:1/callback?code=ac_a&state=s1'),
    ).rejects.toThrow(/--no-browser/);
  });

  it('rejects a state mismatch', async () => {
    auth.startHeadlessOAuthLogin();
    await expect(
      auth.completeHeadlessOAuthLogin('http://127.0.0.1:1/callback?code=ac_a&state=WRONG'),
    ).rejects.toThrow(/state mismatch/i);
  });

  it('rejects an expired pending login and clears it', async () => {
    auth.startHeadlessOAuthLogin();
    const pending = config.getPendingLogin()!;
    config.savePendingLogin({
      ...pending,
      created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    });
    await expect(
      auth.completeHeadlessOAuthLogin(`http://127.0.0.1:1/callback?code=ac_a&state=${pending.state}`),
    ).rejects.toThrow(/expired/i);
    expect(config.getPendingLogin()).toBeNull();
  });

  it('exchanges the code with the pending PKCE verifier and stores credentials', async () => {
    const fetchMock = stubTokenAndProfileFetch();
    const { redirectUri } = auth.startHeadlessOAuthLogin();
    const pending = config.getPendingLogin()!;

    const creds = await auth.completeHeadlessOAuthLogin(
      `${redirectUri}?code=ac_good&state=${pending.state}`,
    );

    // Token exchange used the persisted verifier + the exact redirect_uri.
    const tokenCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/token'))!;
    const body = JSON.parse((tokenCall[1] as RequestInit).body as string);
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'ac_good',
      redirect_uri: redirectUri,
      code_verifier: pending.code_verifier,
    });

    expect(creds.access_token).toBe('at_test');
    expect(creds.user.email).toBe('t@x.dev');

    // Pending file is single-use; credentials are persisted 0600.
    expect(config.getPendingLogin()).toBeNull();
    const credFile = join(mocks.home, '.insforge', 'credentials.json');
    expect(existsSync(credFile)).toBe(true);
    expect(JSON.parse(readFileSync(credFile, 'utf-8')).access_token).toBe('at_test');
  });
});
