import { describe, it, expect, vi, beforeEach } from 'vitest';

const ossMock = vi.hoisted(() => ({ ossFetch: vi.fn() }));
vi.mock('./oss.js', () => ossMock);

import { fetchOssPosthogConnection, readOssPosthogConnection, storePosthogKey } from './posthog.js';
import { CLIError } from '../errors.js';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

beforeEach(() => {
  ossMock.ossFetch.mockReset();
});

describe('fetchOssPosthogConnection', () => {
  it('returns the connection when the backend has one', async () => {
    ossMock.ossFetch.mockResolvedValue(
      jsonResponse({ connected: true, connection: { apiKey: 'phc_pub', host: 'h' } }),
    );

    await expect(fetchOssPosthogConnection()).resolves.toMatchObject({ apiKey: 'phc_pub' });
  });

  // Best-effort probe: any failure must resolve null so callers fall through
  // to the pre-existing flows — cloud must not start failing on this endpoint.
  it('resolves null on any probe failure instead of throwing', async () => {
    ossMock.ossFetch.mockRejectedValue(new Error('fetch failed'));
    await expect(fetchOssPosthogConnection()).resolves.toBeNull();

    ossMock.ossFetch.mockRejectedValue(new Error('not_connected'));
    await expect(fetchOssPosthogConnection()).resolves.toBeNull();
  });

  it('resolves null when the body carries no usable connection', async () => {
    ossMock.ossFetch.mockResolvedValue(jsonResponse({ connection: {} }));
    await expect(fetchOssPosthogConnection()).resolves.toBeNull();
  });
});

describe('readOssPosthogConnection (strict)', () => {
  it('maps not_connected and route-miss to null', async () => {
    ossMock.ossFetch.mockRejectedValue(new CLIError('not_connected'));
    await expect(readOssPosthogConnection()).resolves.toBeNull();

    ossMock.ossFetch.mockRejectedValue(new CLIError('OSS request failed: 404'));
    await expect(readOssPosthogConnection()).resolves.toBeNull();
  });

  // Unlike the probe: after a successful store, a real backend failure must
  // surface its actual error, not a generic "no connection".
  it('propagates real failures', async () => {
    ossMock.ossFetch.mockRejectedValue(new CLIError('Internal server error'));
    await expect(readOssPosthogConnection()).rejects.toThrow(/Internal server error/);
  });
});

describe('fetchOssPosthogConnection probe timeout', () => {
  it('gives up on a hung backend instead of blocking the OAuth flow', async () => {
    vi.useFakeTimers();
    // Hangs until the probe's own AbortSignal fires.
    ossMock.ossFetch.mockImplementation(
      (_path: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const pending = fetchOssPosthogConnection();
    await vi.advanceTimersByTimeAsync(3000);

    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });
});

describe('storePosthogKey', () => {
  const INPUT = { personalApiKey: 'phx_secret', region: 'US' as const };

  it('returns the config when the backend reports the key stored', async () => {
    ossMock.ossFetch.mockResolvedValue(
      jsonResponse({ personalApiKey: { configured: true, maskedKey: 'phx_••' } }),
    );

    await expect(storePosthogKey(INPUT)).resolves.toMatchObject({
      personalApiKey: { configured: true },
    });
    expect(ossMock.ossFetch).toHaveBeenCalledWith('/api/analytics/config', {
      method: 'PUT',
      body: JSON.stringify(INPUT),
    });
  });

  it('fails when the backend does not report the key as stored', async () => {
    ossMock.ossFetch.mockResolvedValue(
      jsonResponse({ personalApiKey: { configured: false, maskedKey: null } }),
    );

    await expect(storePosthogKey(INPUT)).rejects.toThrow(/did not report/);
  });

  it('fails on an unparseable response instead of pretending success', async () => {
    ossMock.ossFetch.mockResolvedValue({
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as Response);

    await expect(storePosthogKey(INPUT)).rejects.toThrow(/no key status/);
  });

  // Unlike the probe, store rejections carry actionable messages — propagate.
  it('propagates backend rejections untouched', async () => {
    ossMock.ossFetch.mockRejectedValue(new Error('This key can see 5 PostHog projects.'));

    await expect(storePosthogKey(INPUT)).rejects.toThrow(/5 PostHog projects/);
  });
});
