import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { URL } from 'node:url';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import { isInteractive } from './prompts.js';
import { getGlobalConfig, getPlatformApiUrl, saveCredentials } from './config.js';
import { getProfile } from './api/platform.js';
import { formatFetchError } from './errors.js';
import type { StoredCredentials } from '../types.js';

// Default OAuth client for InsForge CLI (pre-registered on the platform)
export const DEFAULT_CLIENT_ID = 'clf_NK8cMUs41gm8ZcfdtSguVw';
export const OAUTH_SCOPES = 'user:read organizations:read projects:read projects:write';

export interface PKCEChallenge {
  code_verifier: string;
  code_challenge: string;
}

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

/**
 * Generate PKCE code_verifier and code_challenge (S256).
 */
export function generatePKCE(): PKCEChallenge {
  const code_verifier = randomBytes(32).toString('base64url');
  const code_challenge = createHash('sha256').update(code_verifier).digest('base64url');
  return { code_verifier, code_challenge };
}

/**
 * Generate a random state parameter for CSRF protection.
 */
export function generateState(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Build the OAuth authorization URL.
 */
export function buildAuthorizeUrl(params: {
  platformUrl: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes: string;
}): string {
  const url = new URL(`${params.platformUrl}/api/oauth/v1/authorize`);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', params.scopes);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  return url.toString();
}

/**
 * Exchange authorization code for tokens via the token endpoint.
 */
export async function exchangeCodeForTokens(params: {
  platformUrl: string;
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }> {
  const tokenUrl = `${params.platformUrl}/api/oauth/v1/token`;
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri,
        client_id: params.clientId,
        code_verifier: params.codeVerifier,
      }),
    });
  } catch (err) {
    throw new Error(`Token exchange failed — ${formatFetchError(err, tokenUrl)}`, { cause: err });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error_description?: string; error?: string };
    throw new Error(err.error_description ?? err.error ?? `Token exchange failed (HTTP ${res.status})`);
  }

  return await res.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string };
}

/**
 * Refresh an OAuth access token using a refresh token.
 */
export async function refreshOAuthToken(params: {
  platformUrl: string;
  refreshToken: string;
  clientId: string;
}): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const tokenUrl = `${params.platformUrl}/api/oauth/v1/token`;
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: params.refreshToken,
        client_id: params.clientId,
      }),
    });
  } catch (err) {
    throw new Error(`Token refresh failed — ${formatFetchError(err, tokenUrl)}`, { cause: err });
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error_description?: string; error?: string };
    throw new Error(err.error_description ?? err.error ?? `Token refresh failed (HTTP ${res.status})`);
  }

  return await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
}

/**
 * Start a local HTTP server to receive the OAuth authorization code callback.
 */
export function startCallbackServer(): Promise<{
  port: number;
  result: Promise<OAuthCallbackResult>;
  close: () => void;
}> {
  return new Promise((resolveServer) => {
    let resolveResult: (value: OAuthCallbackResult) => void;
    let rejectResult: (reason: Error) => void;

    const resultPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          const desc = url.searchParams.get('error_description') ?? error;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h2>Authentication failed</h2><p>${desc}</p><p>You can close this window.</p></body></html>`);
          rejectResult!(new Error(desc));
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Invalid callback</h2><p>Missing authorization code.</p></body></html>');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authentication successful!</h2><p>You can close this window and return to the terminal.</p></body></html>');
        resolveResult!({ code, state });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' ? addr!.port : 0;
      resolveServer({
        port,
        result: resultPromise,
        close: () => { server.close(); server.closeAllConnections(); },
      });
    });

    // Timeout after 5 minutes (unref so it doesn't keep the process alive)
    setTimeout(() => {
      rejectResult!(new Error('Authentication timed out. Please try again.'));
      server.close();
    }, 5 * 60 * 1000).unref();
  });
}

/**
 * Perform the full OAuth PKCE login flow:
 * generate PKCE + state, start callback server, open browser, exchange code, save credentials.
 * Returns the stored credentials on success.
 */
export async function performOAuthLogin(apiUrl?: string): Promise<StoredCredentials> {
  const platformUrl = getPlatformApiUrl(apiUrl);
  const config = getGlobalConfig();
  const clientId = config.oauth_client_id ?? DEFAULT_CLIENT_ID;

  // 1. Generate PKCE and state
  const pkce = generatePKCE();
  const state = generateState();

  // 2. Start local callback server
  const { port, result, close } = await startCallbackServer();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // 3. Build authorization URL
  const authUrl = buildAuthorizeUrl({
    platformUrl,
    clientId,
    redirectUri,
    codeChallenge: pkce.code_challenge,
    state,
    scopes: OAUTH_SCOPES,
  });

  if (isInteractive) {
    clack.log.info('Opening browser for authentication...');
    clack.log.info(`If browser doesn't open, visit:\n${authUrl}`);
  } else {
    // Non-TTY (agent shell): surface the URL prominently so the agent can relay it to the human
    process.stdout.write(`\nTo sign in, open this URL in your browser:\n\n  ${pc.cyan(pc.underline(authUrl))}\n\n`);
  }

  // 4. Open browser (best effort — often works even from agent shells since we're on the same machine)
  try {
    const open = (await import('open')).default;
    await open(authUrl);
  } catch {
    if (isInteractive) clack.log.warn('Could not open browser. Please visit the URL above.');
  }

  // 5. Wait for callback — use clack spinner only in TTY (non-TTY spinner renders garbage)
  const s = isInteractive ? clack.spinner() : null;
  s?.start('Waiting for authentication...');
  if (!isInteractive) process.stdout.write('Waiting for authentication...\n');

  try {
    const callbackResult = await result;
    close();

    // Verify state
    if (callbackResult.state !== state) {
      s?.stop('Authentication failed');
      throw new Error('State mismatch. Possible CSRF attack.');
    }

    // 6. Exchange code for tokens
    s?.message('Exchanging authorization code...');
    const tokens = await exchangeCodeForTokens({
      platformUrl,
      code: callbackResult.code,
      redirectUri,
      clientId,
      codeVerifier: pkce.code_verifier,
    });

    // 7. Save credentials and fetch profile
    const creds: StoredCredentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      user: { id: '', name: '', email: '', avatar_url: null, email_verified: true },
    };
    saveCredentials(creds);

    try {
      const profile = await getProfile(apiUrl);
      creds.user = profile;
      saveCredentials(creds);
      s?.stop(`Authenticated as ${profile.email}`);
      if (!isInteractive) process.stdout.write(`Authenticated as ${profile.email}\n`);
    } catch {
      s?.stop('Authenticated successfully');
      if (!isInteractive) process.stdout.write('Authenticated successfully\n');
    }

    return creds;
  } catch (err) {
    close();
    s?.stop('Authentication failed');
    if (!isInteractive) process.stdout.write('Authentication failed\n');
    throw err;
  }
}
