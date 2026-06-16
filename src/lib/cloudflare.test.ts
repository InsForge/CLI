import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCloudflareAuthorizeUrl,
  listCloudflareAccounts,
  performCloudflareOAuthLogin,
  registerCloudflareDomain,
  upsertCloudflareDnsRecord,
} from './cloudflare.js';

describe('Cloudflare OAuth helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('builds the Cloudflare OAuth URL with PKCE and the fixed CLI callback', () => {
    const url = new URL(buildCloudflareAuthorizeUrl({
      state: 'state-123456',
      codeChallenge: 'challenge-abc',
    }));

    expect(url.origin + url.pathname).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(url.searchParams.get('client_id')).toBe('18cf4d9bc2f1b53f205cf92ec4f143c8');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8787/callback');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe(
      'registrar-domains.admin registrar-domains.read dns.write dns.read zone.write zone.read account-settings.read',
    );
  });

  it('allows a development override for the Cloudflare OAuth client id', () => {
    vi.stubEnv('INSFORGE_CLOUDFLARE_OAUTH_CLIENT_ID', 'dev-client-id');
    const url = new URL(buildCloudflareAuthorizeUrl({
      state: 'state-123456',
      codeChallenge: 'challenge-abc',
    }));

    expect(url.searchParams.get('client_id')).toBe('dev-client-id');
  });

  it('registers domains with auto-renew and WHOIS redaction enabled', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account-123');
    vi.stubEnv('CLOUDFLARE_ACCESS_TOKEN', 'oauth-access-token');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: {
        domain_name: 'example.dev',
        state: 'in_progress',
        completed: false,
      },
      errors: [],
      messages: [],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await registerCloudflareDomain('example.dev');

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      domain_name: 'example.dev',
      auto_renew: true,
      privacy_mode: 'redaction',
    });
  });

  it('lists Cloudflare accounts with the OAuth access token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: [
        {
          id: 'account-123',
          name: 'Demo Account',
          type: 'standard',
        },
      ],
      errors: [],
      messages: [],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const accounts = await listCloudflareAccounts({
      accountId: '',
      accessToken: 'oauth-access-token',
    });

    expect(accounts).toEqual([
      {
        id: 'account-123',
        name: 'Demo Account',
        type: 'standard',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-access-token',
        }),
      }),
    );
  });

  it('creates a new TXT record instead of overwriting an unrelated one', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account-123');
    vi.stubEnv('CLOUDFLARE_ACCESS_TOKEN', 'oauth-access-token');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({
          success: true,
          result: {
            id: 'new-record',
            type: 'TXT',
            name: '_vercel.example.com',
            content: 'vc-domain-verify=example.com,new',
          },
          errors: [],
          messages: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        result: [
          {
            id: 'existing-record',
            type: 'TXT',
            name: '_vercel.example.com',
            content: 'vc-domain-verify=example.com,old',
          },
        ],
        errors: [],
        messages: [],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await upsertCloudflareDnsRecord('zone-123', {
      type: 'TXT',
      name: '_vercel.example.com',
      content: 'vc-domain-verify=example.com,new',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records?type=TXT&name=_vercel.example.com',
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('updates an existing TXT record when the content already matches', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account-123');
    vi.stubEnv('CLOUDFLARE_ACCESS_TOKEN', 'oauth-access-token');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Response(JSON.stringify({
          success: true,
          result: {
            id: 'existing-record',
            type: 'TXT',
            name: '_vercel.example.com',
            content: 'vc-domain-verify=example.com,same',
          },
          errors: [],
          messages: [],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        result: [
          {
            id: 'existing-record',
            type: 'TXT',
            name: '_vercel.example.com',
            content: 'vc-domain-verify=example.com,same',
          },
        ],
        errors: [],
        messages: [],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await upsertCloudflareDnsRecord('zone-123', {
      type: 'TXT',
      name: '_vercel.example.com',
      content: 'vc-domain-verify=example.com,same',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/zones/zone-123/dns_records/existing-record',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('rejects login immediately when the OAuth callback state does not match', async () => {
    // Silence the OAuth URL banner the login flow writes to stderr.
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // Without the fix this never settles and the test times out instead of
    // hanging the real CLI for the full 5-minute callback timeout.
    const loginPromise = performCloudflareOAuthLogin({ skipBrowser: true });
    const rejection = expect(loginPromise).rejects.toThrow('Cloudflare OAuth state mismatch.');

    // Wait for the callback server to bind, then deliver a mismatched state.
    let delivered = false;
    for (let attempt = 0; attempt < 50 && !delivered; attempt += 1) {
      try {
        await fetch('http://127.0.0.1:8787/callback?code=test-code&state=wrong-state');
        delivered = true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(delivered).toBe(true);

    await rejection;
    stderrSpy.mockRestore();
  });
});
