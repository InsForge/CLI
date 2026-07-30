import { afterEach, describe, expect, it, vi } from 'vitest';
import * as oss from './oss.js';
import { CLIError } from '../errors.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storeApifyToken', () => {
  it('PUTs the token to the OSS host and returns the masked status', async () => {
    const spy = vi.spyOn(oss, 'ossFetch').mockResolvedValue(
      new Response(
        JSON.stringify({ token: { configured: true, maskedKey: 'apify_ap••••••••mnop' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { storeApifyToken } = await import('./apify-config.js');

    await expect(storeApifyToken('apify_api_tok1234567890')).resolves.toEqual({
      configured: true,
      maskedKey: 'apify_ap••••••••mnop',
    });
    expect(spy).toHaveBeenCalledWith('/api/webscraper/apify/config', {
      method: 'PUT',
      body: JSON.stringify({ apiToken: 'apify_api_tok1234567890' }),
    });
  });

  it('propagates the backend message when Apify rejects the token', async () => {
    vi.spyOn(oss, 'ossFetch').mockRejectedValue(
      new CLIError('Apify rejected this API token.', 1, 'INVALID_INPUT', 400),
    );

    const { storeApifyToken } = await import('./apify-config.js');

    await expect(storeApifyToken('bogus')).rejects.toThrow(/Apify rejected this API token/);
  });

  it('propagates the cloud-managed message on a cloud project', async () => {
    vi.spyOn(oss, 'ossFetch').mockRejectedValue(
      new CLIError('The Apify connection is managed by InsForge Cloud.', 1, 'INVALID_INPUT', 400),
    );

    const { storeApifyToken } = await import('./apify-config.js');

    await expect(storeApifyToken('apify_api_tok1234567890')).rejects.toThrow(/InsForge Cloud/);
  });

  it('fails loudly when the response carries no token status', async () => {
    vi.spyOn(oss, 'ossFetch').mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { storeApifyToken } = await import('./apify-config.js');

    await expect(storeApifyToken('apify_api_tok1234567890')).rejects.toThrow(
      /no token status/i,
    );
  });
});
