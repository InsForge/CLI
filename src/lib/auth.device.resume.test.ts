import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

// Resume behavior of `login --device`: a killed poller's pending device code
// is reused by the next invocation instead of minting a fresh one.

// GLOBAL_DIR in config.ts is derived from homedir() at import time, so the
// mock must be in place before auth.js/config.js are (dynamically) imported.
import type * as AuthModule from './auth.js';
import type * as ConfigModule from './config.js';
import type * as OsModule from 'node:os';
import type { PendingDeviceLogin } from '../types.js';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof OsModule>();
  return { ...actual, homedir: () => mocks.home || actual.homedir() };
});
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }));

let auth: typeof AuthModule;
let config: typeof ConfigModule;

const PLATFORM = 'https://api.example.dev';

beforeAll(async () => {
  mocks.home = mkdtempSync(join(tmpdir(), 'insforge-device-resume-'));
  auth = await import('./auth.js');
  config = await import('./config.js');
});

afterAll(() => {
  rmSync(mocks.home, { recursive: true, force: true });
});

beforeEach(() => {
  config.clearPendingDeviceLogin();
  config.clearCredentials();
  config.saveGlobalConfig({ platform_api_url: PLATFORM });
  vi.unstubAllGlobals();
});

function stubFetch(handlers: {
  deviceAuthorization?: () => Response;
  token: (body: Record<string, string>) => Response;
}) {
  const calls = { deviceAuthorization: 0, token: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/device_authorization')) {
        calls.deviceAuthorization++;
        if (!handlers.deviceAuthorization) throw new Error('unexpected device_authorization call');
        return handlers.deviceAuthorization();
      }
      if (url.includes('/oauth/v1/token')) {
        calls.token++;
        return handlers.token(JSON.parse((init?.body as string) ?? '{}'));
      }
      if (url.includes('/auth/v1/profile')) {
        return new Response(
          JSON.stringify({ user: { id: 'u1', name: 'T', email: 't@x.dev', avatar_url: null, email_verified: true } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

const tokens = () =>
  new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const oauthError = (error: string) =>
  new Response(JSON.stringify({ error }), { status: 400, headers: { 'Content-Type': 'application/json' } });

const pendingFixture = (overrides: Partial<PendingDeviceLogin> = {}) => ({
  device_code: 'dvc_previous',
  user_code: 'BCDF-GHJK',
  verification_uri_complete: 'https://insforge.dev/auth/device?user_code=BCDF-GHJK',
  interval: 0.01,
  expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  platform_url: PLATFORM,
  client_id: 'clf_NK8cMUs41gm8ZcfdtSguVw',
  ...overrides,
});

describe('performDeviceLogin pending-state lifecycle', () => {
  it('fresh login persists pending state, then clears it on success', async () => {
    let firstPoll = true;
    const calls = stubFetch({
      deviceAuthorization: () =>
        new Response(
          JSON.stringify({
            device_code: 'dvc_fresh',
            user_code: 'MNPQ-RSTV',
            verification_uri: 'https://insforge.dev/auth/device',
            verification_uri_complete: 'https://insforge.dev/auth/device?user_code=MNPQ-RSTV',
            expires_in: 900,
            interval: 0.01,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      token: () => {
        if (firstPoll) {
          firstPoll = false;
          // Pending state must exist WHILE polling (that's what a killed
          // process leaves behind for the next run).
          expect(config.getPendingDeviceLogin()?.device_code).toBe('dvc_fresh');
          return oauthError('authorization_pending');
        }
        return tokens();
      },
    });

    const creds = await auth.performDeviceLogin();
    expect(creds.access_token).toBe('at');
    expect(calls.deviceAuthorization).toBe(1);
    expect(config.getPendingDeviceLogin()).toBeNull();
  });

  it('resumes a still-valid pending attempt: no new code minted, same device_code polled', async () => {
    config.savePendingDeviceLogin(pendingFixture());

    const polledCodes: string[] = [];
    stubFetch({
      // deviceAuthorization handler intentionally omitted — calling it fails the test
      token: (body) => {
        polledCodes.push(body.device_code);
        return tokens();
      },
    });

    const creds = await auth.performDeviceLogin();
    expect(creds.access_token).toBe('at');
    expect(polledCodes).toEqual(['dvc_previous']);
    expect(config.getPendingDeviceLogin()).toBeNull();
  });

  it('ignores pending state that is nearly expired or from another server', async () => {
    config.savePendingDeviceLogin(pendingFixture({ expires_at: new Date(Date.now() + 30_000).toISOString() }));

    stubFetch({
      deviceAuthorization: () =>
        new Response(
          JSON.stringify({
            device_code: 'dvc_fresh2',
            user_code: 'WXZB-CDFG',
            verification_uri: 'https://insforge.dev/auth/device',
            verification_uri_complete: 'https://insforge.dev/auth/device?user_code=WXZB-CDFG',
            expires_in: 900,
            interval: 0.01,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      token: () => tokens(),
    });

    await auth.performDeviceLogin();
    // A fresh code replaced the nearly-expired one.
    expect(config.getPendingDeviceLogin()).toBeNull();
  });

  it('clears pending state on denial so the next run starts fresh', async () => {
    config.savePendingDeviceLogin(pendingFixture());
    stubFetch({ token: () => oauthError('access_denied') });

    await expect(auth.performDeviceLogin()).rejects.toThrow(/denied/i);
    expect(config.getPendingDeviceLogin()).toBeNull();
  });

  it('keeps pending state on transient poll failure so a rerun can resume', async () => {
    config.savePendingDeviceLogin(pendingFixture({ expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString() }));
    stubFetch({ token: () => oauthError('server_error') });

    await expect(auth.performDeviceLogin()).rejects.toThrow();
    expect(config.getPendingDeviceLogin()?.device_code).toBe('dvc_previous');
  });
});
