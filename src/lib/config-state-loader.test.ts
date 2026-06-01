import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIError } from './errors.js';

const ossFetchMock = vi.hoisted(() => vi.fn());

vi.mock('./api/oss.js', () => ({
  ossFetch: ossFetchMock,
}));

import { loadConfigState } from './config-metadata.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('loadConfigState', () => {
  beforeEach(() => {
    ossFetchMock.mockReset();
  });

  it('treats route-level missing optional endpoints as unsupported', async () => {
    ossFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/metadata') return jsonResponse({ auth: {} });
      if (path === '/api/storage/config') throw new CLIError('OSS request failed: 404');
      return jsonResponse({});
    });

    await expect(loadConfigState()).resolves.toEqual({
      metadata: { auth: {} },
      realtimeConfig: {},
      schedulesConfig: {},
    });
    expect(ossFetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/metadata',
      '/api/storage/config',
      '/api/realtime/config',
      '/api/schedules/config',
    ]);
  });

  it('surfaces resource-level optional endpoint failures', async () => {
    ossFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/metadata') return jsonResponse({ auth: {} });
      if (path === '/api/storage/config') throw new CLIError('Storage config not found');
      return jsonResponse({});
    });

    await expect(loadConfigState()).rejects.toThrow('Storage config not found');
  });
});
