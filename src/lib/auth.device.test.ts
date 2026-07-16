import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestDeviceAuthorization, pollForDeviceTokens } from './auth.js';

const PLATFORM = 'https://api.example.dev';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('requestDeviceAuthorization', () => {
  it('posts client_id + scope and returns the device authorization', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        device_code: 'dvc_abc',
        user_code: 'BCDF-GHJK',
        verification_uri: 'https://insforge.dev/auth/device',
        verification_uri_complete: 'https://insforge.dev/auth/device?user_code=BCDF-GHJK',
        expires_in: 900,
        interval: 5,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestDeviceAuthorization({
      platformUrl: PLATFORM,
      clientId: 'clf_test',
      scopes: 'user:read',
    });

    expect(result.user_code).toBe('BCDF-GHJK');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${PLATFORM}/api/oauth/v1/device_authorization`);
    expect(JSON.parse(init.body as string)).toEqual({ client_id: 'clf_test', scope: 'user:read' });
  });

  it('explains when the server does not support device login', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized_client' }, 400)));

    await expect(
      requestDeviceAuthorization({ platformUrl: PLATFORM, clientId: 'clf_test', scopes: 's' })
    ).rejects.toThrow(/not enabled/i);
  });
});

describe('pollForDeviceTokens', () => {
  const params = {
    platformUrl: PLATFORM,
    clientId: 'clf_test',
    deviceCode: 'dvc_abc',
    interval: 0.01,
    expiresIn: 5,
  };

  it('keeps polling through authorization_pending, then returns tokens', async () => {
    const responses = [
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await pollForDeviceTokens(params);
    expect(tokens.access_token).toBe('at');
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(body.device_code).toBe('dvc_abc');
  });

  it('backs off on slow_down and still completes', async () => {
    const responses = [
      jsonResponse({ error: 'slow_down' }, 400),
      jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));

    // slow_down adds 5s; keep the test fast by capping expiresIn so failure
    // would surface as an expiry error if backoff logic breaks the loop.
    const tokens = await pollForDeviceTokens({ ...params, expiresIn: 30 });
    expect(tokens.access_token).toBe('at');
  }, 15_000);

  it('stops with a clear error when the user denies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'access_denied' }, 400)));
    await expect(pollForDeviceTokens(params)).rejects.toThrow(/denied/i);
  });

  it('stops with a clear error when the code expires server-side', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'expired_token' }, 400)));
    await expect(pollForDeviceTokens(params)).rejects.toThrow(/expired/i);
  });

  it('gives up at the local deadline if approval never happens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'authorization_pending' }, 400)));
    await expect(pollForDeviceTokens({ ...params, expiresIn: 0.05 })).rejects.toThrow(/expired/i);
  });

  it('defaults to a 5s interval when the server omits it (RFC 8628 §3.2)', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () =>
        jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      );
      vi.stubGlobal('fetch', fetchMock);

      const promise = pollForDeviceTokens({ ...params, interval: undefined });

      // A missing interval must NOT collapse to a zero-delay hammer loop.
      await vi.advanceTimersByTimeAsync(4900);
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(200);
      await expect(promise).resolves.toMatchObject({ access_token: 'at' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives transient network errors and keeps polling', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('ECONNRESET');
        return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
      })
    );

    const tokens = await pollForDeviceTokens(params);
    expect(tokens.access_token).toBe('at');
    expect(calls).toBe(2);
  });
});
