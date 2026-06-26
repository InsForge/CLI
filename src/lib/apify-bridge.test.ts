import { afterEach, describe, expect, it, vi } from 'vitest';

// The bridge fetches the token first, then charset-validates it BEFORE any
// shell exec. Mock the token source so we can drive the validation path without
// touching the network, the Apify CLI, or the filesystem.
vi.mock('./api/apify-token.js', () => ({
  fetchApifyAccessToken: vi.fn(),
}));

import { fetchApifyAccessToken } from './api/apify-token.js';
import { runApifyAuthBridge } from './apify-bridge.js';

const mockedFetchToken = vi.mocked(fetchApifyAccessToken);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runApifyAuthBridge token charset guard', () => {
  // Each of these contains a shell metacharacter / space that must never reach
  // `apify login --token <token>` under shell:true on Windows.
  it.each([
    'tok; rm -rf /',
    'tok && calc',
    'tok | cat',
    'tok`whoami`',
    'tok with space',
    'tok$(id)',
    '"quoted"',
  ])('rejects a token containing shell metacharacters: %s', async (badToken) => {
    mockedFetchToken.mockResolvedValue(badToken);
    await expect(runApifyAuthBridge(true)).rejects.toThrow(/Unexpected Apify token format/);
  });
});
