import { getCredentials, getGlobalConfig, getPlatformApiUrl, saveCredentials, getProjectConfig, FAKE_PROJECT_ID } from './config.js';
import { AuthError } from './errors.js';
import { refreshOAuthToken, DEFAULT_CLIENT_ID, performOAuthLogin } from './auth.js';
import * as clack from '@clack/prompts';
import * as prompts from './prompts.js';
import type { StoredCredentials } from '../types.js';

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
  if (!creds?.refresh_token) {
    throw new AuthError('Refresh token not found. Run `npx @insforge/cli login` again.');
  }

  const platformUrl = getPlatformApiUrl(apiUrl);
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
