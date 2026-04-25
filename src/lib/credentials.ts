import { getCredentials, getGlobalConfig, getPlatformApiUrl, saveCredentials, getProjectConfig, FAKE_PROJECT_ID } from './config.js';
import { AuthError } from './errors.js';
import { refreshOAuthToken, DEFAULT_CLIENT_ID, performOAuthLogin } from './auth.js';
import * as clack from '@clack/prompts';
import * as prompts from './prompts.js';
import type { StoredCredentials } from '../types.js';

/** True if stored credentials represent a PAT-based login (refresh_token is a uak_ token). */
export function isPatLogin(creds: StoredCredentials | null | undefined): boolean {
  return creds?.refresh_token?.startsWith('uak_') ?? false;
}

export async function requireAuth(apiUrl?: string, allowOssBypass = true): Promise<StoredCredentials> {
  const projConfig = getProjectConfig();
  if (allowOssBypass && projConfig?.project_id === FAKE_PROJECT_ID) {
    return {
      access_token: 'oss-token',
      refresh_token: 'oss-refresh',
      user: {
        id: 'oss-user',
        name: 'OSS User',
        email: 'oss@insforge.local',
        avatar_url: null,
        email_verified: true,
      },
    };
  }

  const creds = getCredentials();
  if (creds && creds.access_token) return creds;

  // PAT session with an expired/empty access_token: silently re-exchange
  // instead of prompting for browser OAuth.
  if (isPatLogin(creds)) {
    await refreshAccessToken(apiUrl);
    return getCredentials()!;
  }

  clack.log.info('You need to log in to continue.');

  for (;;) {
    try {
      return await performOAuthLogin(apiUrl);
    } catch (err) {
      if (!process.stdout.isTTY) throw err;

      const msg = err instanceof Error ? err.message : 'Unknown error';
      clack.log.error(`Login failed: ${msg}`);

      const retry = await prompts.confirm({ message: 'Would you like to try again?' });
      if (prompts.isCancel(retry) || !retry) {
        throw new AuthError('Authentication required. Run `npx @insforge/cli login` to authenticate.');
      }
    }
  }
}

export async function refreshAccessToken(apiUrl?: string): Promise<string> {
  const creds = getCredentials();
  if (!creds) {
    throw new AuthError('Not logged in. Run `npx @insforge/cli login` first.');
  }

  const platformUrl = getPlatformApiUrl(apiUrl);

  // PAT branch: re-exchange the stored uak_ for a fresh JWT.
  if (isPatLogin(creds)) {
    let res: Response;
    try {
      res = await fetch(`${platformUrl}/auth/v1/exchange-api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: creds.refresh_token }),
      });
    } catch {
      // Background refresh path — surface a network error clearly.
      throw new AuthError(
        `Unable to reach auth server at ${platformUrl}. Check your network connection.`
      );
    }
    if (!res.ok) {
      // Auth failures (401/403/404) mean the PAT is actually bad — ask the user
      // to rotate. Everything else (5xx, 429, gateway errors) is transient and
      // shouldn't instruct the user to rotate a healthy key.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new AuthError(
          'API key is invalid or revoked. Run `npx @insforge/cli login --user-api-key <new-key>` again.'
        );
      }
      throw new AuthError(
        `Auth server returned HTTP ${res.status} while refreshing session. Please retry shortly.`
      );
    }
    const data = (await res.json().catch(() => ({}))) as { token?: unknown };
    if (typeof data.token !== 'string' || data.token.length === 0) {
      throw new AuthError('Exchange endpoint returned an invalid response (missing token).');
    }
    saveCredentials({ ...creds, access_token: data.token });
    return data.token;
  }

  if (!creds.refresh_token) {
    throw new AuthError('Refresh token not found. Run `npx @insforge/cli login` again.');
  }

  const config = getGlobalConfig();
  const clientId = config.oauth_client_id ?? DEFAULT_CLIENT_ID;

  try {
    const data = await refreshOAuthToken({
      platformUrl,
      refreshToken: creds.refresh_token,
      clientId,
    });

    const updated: StoredCredentials = {
      ...creds,
      access_token: data.access_token,
      // Update refresh token if rotated
      refresh_token: data.refresh_token ?? creds.refresh_token,
    };
    saveCredentials(updated);
    return data.access_token;
  } catch {
    // Token refresh failed — try re-authenticating interactively
    if (process.stdout.isTTY) {
      clack.log.warn('Session expired. Please log in again.');
      const newCreds = await performOAuthLogin(apiUrl);
      return newCreds.access_token;
    }
    throw new AuthError('Failed to refresh token. Run `npx @insforge/cli login` again.');
  }
}
