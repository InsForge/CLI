import { describe, it, expect, vi, beforeEach } from 'vitest';

const ossMock = vi.hoisted(() => ({ ossFetch: vi.fn() }));
vi.mock('./oss.js', () => ossMock);

import { fetchOssPosthogConnection, storePosthogKey } from './posthog.js';

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
