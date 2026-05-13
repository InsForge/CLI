import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getOpenRouterApiKey } from './ai.js';

vi.mock('./oss.js', () => ({
  ossFetch: vi.fn(),
}));

describe('getOpenRouterApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the OpenRouter key from the AI backend endpoint', async () => {
    const { ossFetch } = await import('./oss.js');
    (ossFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ apiKey: ' sk-or-test ', maskedKey: ' sk-or-****test ' }),
    });

    await expect(getOpenRouterApiKey()).resolves.toEqual({
      apiKey: 'sk-or-test',
      maskedKey: 'sk-or-****test',
    });
    expect(ossFetch).toHaveBeenCalledWith('/api/ai/openrouter/api-key');
  });

  it('throws a clear error when the backend returns no raw key', async () => {
    const { ossFetch } = await import('./oss.js');
    (ossFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ maskedKey: 'sk-or-****test' }),
    });

    await expect(getOpenRouterApiKey()).rejects.toThrow(/returned no OpenRouter API key/);
  });

  it('throws a clear error when the backend returns a whitespace-only key', async () => {
    const { ossFetch } = await import('./oss.js');
    (ossFetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: async () => ({ apiKey: '   ', maskedKey: 'sk-or-****test' }),
    });

    await expect(getOpenRouterApiKey()).rejects.toThrow(/returned no OpenRouter API key/);
  });
});
