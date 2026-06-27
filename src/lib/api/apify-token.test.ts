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

  it('remaps the resource-level not_connected 404 to a connect remediation', async () => {
    const notConnected = new CLIError('Not connected', 1, 'not_connected', 404);
    vi.spyOn(oss, 'ossFetch').mockRejectedValue(notConnected);

    const { fetchApifyAccessToken } = await import('./apify-token.js');
    await expect(fetchApifyAccessToken()).rejects.toThrow(/not connected.*connect/is);
  });

  it('propagates a route-level 404 unchanged (data source unsupported, not "run connect")', async () => {
    // ossFetch rewrites a bare route-level 404 to a "not available on this
    // backend" message; we must not clobber it with "run connect".
    const routeMiss = new CLIError(
      'The web scraper is not available on this backend.',
      1,
      'NOT_FOUND',
      404,
    );
    vi.spyOn(oss, 'ossFetch').mockRejectedValue(routeMiss);

    const { fetchApifyAccessToken } = await import('./apify-token.js');
    await expect(fetchApifyAccessToken()).rejects.toThrow(/not available on this backend/i);
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
