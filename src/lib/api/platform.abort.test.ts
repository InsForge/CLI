import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getCredentials: vi.fn(),
  getPlatformApiUrl: vi.fn(),
}));
const credentialsMock = vi.hoisted(() => ({
  refreshAccessToken: vi.fn(),
}));

vi.mock('../config.js', () => configMock);
vi.mock('../credentials.js', () => credentialsMock);

import { platformFetch } from './platform.js';

describe('platformFetch cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.getAccessToken.mockReturnValue('expired-token');
    configMock.getPlatformApiUrl.mockReturnValue('https://platform.example.test');
  });

  it('passes the request signal to a 401 token refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const controller = new AbortController();
    credentialsMock.refreshAccessToken.mockImplementation(
      (_apiUrl: string | undefined, signal: AbortSignal) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Refresh aborted')));
      }),
    );

    const pending = platformFetch('/projects/v1/project-id', { signal: controller.signal });
    await vi.waitFor(() => expect(credentialsMock.refreshAccessToken).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).rejects.toThrow('Refresh aborted');
    expect(credentialsMock.refreshAccessToken).toHaveBeenCalledWith(undefined, controller.signal);
  });
});
