import { getCredentials, getGlobalConfig, getPlatformApiUrl, saveCredentials, getProjectConfig, FAKE_PROJECT_ID } from './config.js';
import { AuthError } from './errors.js';
import { refreshOAuthToken, DEFAULT_CLIENT_ID, performOAuthLogin } from './auth.js';
import * as clack from '@clack/prompts';
import * as prompts from './prompts.js';
import type { StoredCredentials } from '../types.js';

/** True if stored credentials represent an exchange-based PAT login (refresh_token is a uak_ token). */
export function isPatLogin(creds: StoredCredentials | null | undefined): boolean {
  return creds?.refresh_token?.startsWith('uak_') ?? false;
}

/** True if stored credentials use a direct user API key (uak_) as the bearer token. */
export function isDirectApiKeyLogin(creds: StoredCredentials | null | undefined): boolean {
  return !!creds?.user_api_key;
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
  // A direct API key or a present access token is enough to proceed.
  if (creds && (creds.user_api_key || creds.access_token)) return creds;

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

export async function refreshAccessToken(apiUrl?: string, signal?: AbortSignal): Promise<string> {
  const creds = getCredentials();
  if (!creds) {
    throw new AuthError('Not logged in. Run `npx @insforge/cli login` first.');
  }

  const platformUrl = getPlatformApiUrl(apiUrl);

  // Direct API key: the uak_ IS the credential and cannot be refreshed.
  // Reaching here means a request 401'd with the key attached, i.e. the key was
  // revoked or expired — surface a clear re-login message rather than looping.
  if (isDirectApiKeyLogin(creds)) {
    throw new AuthError(
      'API key is invalid, revoked, or expired. Run `npx @insforge/cli login --user-api-key <new-key>` again.'
    );
  }

  // Legacy exchange-PAT session (created by an older CLI: uak_ in refresh_token,
  // JWT in access_token). The uak_ now authenticates directly, so migrate this
  // session to direct auth instead of calling the deprecated exchange endpoint.
  // One-time, no network: promote the key and reuse it going forward.
  if (isPatLogin(creds)) {
    const key = creds.refresh_token;
    saveCredentials({ ...creds, user_api_key: key, access_token: '', refresh_token: '' });
    return key;
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
      signal,
    });

    const updated: StoredCredentials = {
      ...creds,
      access_token: data.access_token,
      // Update refresh token if rotated
      refresh_token: data.refresh_token ?? creds.refresh_token,
    };
    saveCredentials(updated);
    return data.access_token;
  } catch (err) {
    if (signal?.aborted) throw err;
    // Token refresh failed — try re-authenticating interactively
    if (process.stdout.isTTY) {
      clack.log.warn('Session expired. Please log in again.');
      const newCreds = await performOAuthLogin(apiUrl, signal);
      return newCreds.access_token;
    }
    throw new AuthError('Failed to refresh token. Run `npx @insforge/cli login` again.');
  }
}
