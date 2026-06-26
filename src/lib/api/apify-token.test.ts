import { afterEach, describe, expect, it, vi } from 'vitest';
import * as oss from './oss.js';
import { CLIError } from '../errors.js';

// We spy on ossFetch to avoid real network calls.
afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchApifyAccessToken', () => {
  it('returns accessToken from the token endpoint', async () => {
    vi.spyOn(oss, 'ossFetch').mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'integration_api_token_x' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { fetchApifyAccessToken } = await import('./apify-token.js');
    await expect(fetchApifyAccessToken()).resolves.toBe('integration_api_token_x');
  });

  it('throws a clear error when not connected (404)', async () => {
    const err404 = new CLIError('Not found', 1, 'NOT_FOUND', 404);
    vi.spyOn(oss, 'ossFetch').mockRejectedValue(err404);

    const { fetchApifyAccessToken } = await import('./apify-token.js');
    await expect(fetchApifyAccessToken()).rejects.toThrow(/not connected|connect/i);
  });

  it('propagates other errors unchanged', async () => {
    const networkErr = new CLIError('Network error', 1, 'NETWORK', 500);
    vi.spyOn(oss, 'ossFetch').mockRejectedValue(networkErr);

    const { fetchApifyAccessToken } = await import('./apify-token.js');
    await expect(fetchApifyAccessToken()).rejects.toThrow('Network error');
  });

  it('throws when accessToken is missing from response', async () => {
    vi.spyOn(oss, 'ossFetch').mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { fetchApifyAccessToken } = await import('./apify-token.js');
    await expect(fetchApifyAccessToken()).rejects.toThrow(/no token|reconnect/i);
  });
});
