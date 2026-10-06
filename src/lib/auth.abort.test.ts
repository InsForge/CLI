import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpMock = vi.hoisted(() => {
  const state: { handler?: (req: { url?: string }, res: { writeHead: () => void; end: () => void }) => void } = {};
  const server = {
    listen: vi.fn((_port: number, _host: string, onListening: () => void) => onListening()),
    address: vi.fn(() => ({ port: 4567 })),
    close: vi.fn(),
    closeAllConnections: vi.fn(),
  };
  return {
    state,
    server,
    createServer: vi.fn((handler) => {
      state.handler = handler;
      return server;
    }),
  };
});
const configMock = vi.hoisted(() => ({
  getGlobalConfig: vi.fn(),
  getPlatformApiUrl: vi.fn(),
  saveCredentials: vi.fn(),
  getPendingDeviceLogin: vi.fn(),
  savePendingDeviceLogin: vi.fn(),
  clearPendingDeviceLogin: vi.fn(),
}));
const platformMock = vi.hoisted(() => ({ getProfile: vi.fn() }));
const openMock = vi.hoisted(() => vi.fn());

vi.mock('node:http', () => ({ createServer: httpMock.createServer }));
vi.mock('./config.js', () => configMock);
vi.mock('./api/platform.js', () => platformMock);
vi.mock('open', () => ({ default: openMock }));

import { performOAuthLogin, startCallbackServer } from './auth.js';

describe('OAuth login cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.getGlobalConfig.mockReturnValue({});
    configMock.getPlatformApiUrl.mockReturnValue('https://platform.example.test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cancels the callback timeout when the callback server is closed', async () => {
    vi.useFakeTimers();
    try {
      const callback = await startCallbackServer();
      const onRejection = vi.fn();
      void callback.result.catch(onRejection);

      callback.close();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

      expect(onRejection).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates an abort that occurs while fetching the authenticated profile', async () => {
    openMock.mockImplementation(async (authUrl: string) => {
      const url = new URL(authUrl);
      httpMock.state.handler!(
        { url: `/callback?code=test-code&state=${url.searchParams.get('state')}` },
        { writeHead: vi.fn(), end: vi.fn() },
      );
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
    }), { status: 200 })));
    const controller = new AbortController();
    platformMock.getProfile.mockImplementation(
      (_apiUrl: string | undefined, signal: AbortSignal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Profile request aborted')), { once: true });
      }),
    );

    const pending = performOAuthLogin(undefined, controller.signal);
    await vi.waitFor(() => expect(platformMock.getProfile).toHaveBeenCalledTimes(1));
    controller.abort(new Error('Profile request aborted'));

    await expect(pending).rejects.toThrow('Profile request aborted');
  });
});
