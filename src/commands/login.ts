import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as prompts from '../lib/prompts.js';
import { saveCredentials, getPlatformApiUrl } from '../lib/config.js';
import { login as platformLogin } from '../lib/api/platform.js';
import { performOAuthLogin } from '../lib/auth.js';
import { handleError, getRootOpts, CLIError, formatFetchError } from '../lib/errors.js';
import { trackTopLevelUsage } from '../lib/command-telemetry.js';
import type { StoredCredentials, User } from '../types.js';

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with InsForge platform')
    .option('--email', 'Login with email and password instead of browser')
    .option('--client-id <id>', 'OAuth client ID (defaults to insforge-cli)')
    .option('--api-key <key>', 'Authenticate directly with a uak_ user API key (no exchange)')
    .option('--user-api-key <key>', 'Authenticate with a uak_ personal access token (exchanged for a session)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);

      try {
        if (opts.apiKey) {
          await loginWithApiKeyDirect(opts.apiKey, json, apiUrl);
        } else if (opts.userApiKey) {
          await loginWithUserApiKey(opts.userApiKey, json, apiUrl);
        } else if (opts.email) {
          await loginWithEmail(json, apiUrl);
        } else {
          await loginWithOAuth(json, apiUrl);
        }

        await trackTopLevelUsage('login', true);
      } catch (err) {
        if (err instanceof Error && err.message.includes('cancelled')) {
          process.exit(0);
        }
        await trackTopLevelUsage('login', false, {}, err);
        handleError(err, json);
      }
    });
}

async function loginWithEmail(json: boolean, apiUrl?: string): Promise<void> {
  if (!json) {
    clack.intro('InsForge CLI');
  }

  const email = json
    ? process.env.INSFORGE_EMAIL
    : await prompts.text({
        message: 'Email:',
        validate: (v) => (v.includes('@') ? undefined : 'Please enter a valid email'),
      });

  if (prompts.isCancel(email)) {
    clack.cancel('Login cancelled.');
    throw new Error('cancelled');
  }

  const password = json
    ? process.env.INSFORGE_PASSWORD
    : await prompts.password({
        message: 'Password:',
      });

  if (prompts.isCancel(password)) {
    clack.cancel('Login cancelled.');
    throw new Error('cancelled');
  }

  if (!email || !password) {
    throw new Error('Email and password are required. Set INSFORGE_EMAIL and INSFORGE_PASSWORD environment variables for non-interactive mode.');
  }

  if (!json) {
    const s = clack.spinner();
    s.start('Authenticating...');

    const result = await platformLogin(email as string, password as string, apiUrl);
    const creds: StoredCredentials = {
      access_token: result.token,
      refresh_token: result._refreshToken ?? '',
      user: result.user,
    };
    saveCredentials(creds);

    s.stop(`Authenticated as ${result.user.email}`);
    clack.outro('Done');
  } else {
    const result = await platformLogin(email as string, password as string, apiUrl);
    const creds: StoredCredentials = {
      access_token: result.token,
      refresh_token: result._refreshToken ?? '',
      user: result.user,
    };
    saveCredentials(creds);
    console.log(JSON.stringify({ success: true, user: result.user }));
  }
}

async function loginWithOAuth(json: boolean, apiUrl?: string): Promise<void> {
  if (!json) {
    clack.intro('InsForge CLI');
  }

  const creds = await performOAuthLogin(apiUrl);

  if (!json) {
    clack.outro('Done');
  } else {
    console.log(JSON.stringify({ success: true, user: creds.user }));
  }
}

async function loginWithUserApiKey(
  key: string,
  json: boolean,
  apiUrl?: string,
): Promise<void> {
  if (!json) {
    clack.intro('InsForge CLI');
  }

  if (!key.startsWith('uak_')) {
    throw new CLIError('Invalid API key — must start with "uak_".');
  }

  const s = !json ? clack.spinner() : null;
  s?.start('Verifying API key...');

  let jwt: string;
  let user: User;
  try {
    const exchanged = await exchangePatForJwt(key, apiUrl);
    jwt = exchanged.token;
    user = exchanged.user;
  } catch (err) {
    s?.stop('API key verification failed');
    throw err instanceof CLIError
      ? err
      : new CLIError(err instanceof Error ? err.message : String(err));
  }

  // Storage: access_token holds the JWT, refresh_token holds the PAT.
  // Detect PAT login later by checking refresh_token.startsWith('uak_').
  saveCredentials({
    access_token: jwt,
    refresh_token: key,
    user,
  });

  if (!json) {
    s?.stop(`Authenticated as ${user.email}`);
    clack.outro('Done');
  } else {
    console.log(JSON.stringify({ success: true, user }));
  }
}

/**
 * Direct API-key login: store the uak_ key itself as the credential and use it
 * as the Bearer token on every request — no exchange, no JWT, no refresh. We
 * still fetch the profile once (authenticating with the key directly) to
 * validate it and persist identity.
 */
async function loginWithApiKeyDirect(
  key: string,
  json: boolean,
  apiUrl?: string,
): Promise<void> {
  if (!json) {
    clack.intro('InsForge CLI');
  }

  if (!key.startsWith('uak_')) {
    throw new CLIError('Invalid API key — must start with "uak_".');
  }

  const s = !json ? clack.spinner() : null;
  s?.start('Verifying API key...');

  let user: User;
  try {
    user = await fetchProfileWithApiKey(key, apiUrl);
  } catch (err) {
    s?.stop('API key verification failed');
    throw err instanceof CLIError
      ? err
      : new CLIError(err instanceof Error ? err.message : String(err));
  }

  // Store the uak_ as the direct bearer credential. access_token/refresh_token
  // stay empty so getAccessToken() serves user_api_key and refresh logic treats
  // this as a non-refreshable direct login.
  saveCredentials({
    access_token: '',
    refresh_token: '',
    user_api_key: key,
    user,
  });

  if (!json) {
    s?.stop(`Authenticated as ${user.email}`);
    clack.outro('Done');
  } else {
    console.log(JSON.stringify({ success: true, user }));
  }
}

/** Fetch the user profile authenticating with a uak_ key directly as Bearer. */
async function fetchProfileWithApiKey(apiKey: string, apiUrl?: string): Promise<User> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const url = `${baseUrl}/auth/v1/profile`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  } catch (err) {
    throw new CLIError(formatFetchError(err, url));
  }
  if (!res.ok) {
    throw new CLIError(`API key is invalid or revoked: HTTP ${res.status}`);
  }

  const profile = (await res.json().catch(() => null)) as { user?: User } | User | null;
  const user =
    profile && typeof profile === 'object' && 'user' in profile
      ? (profile as { user?: User }).user
      : ((profile as User | null) ?? undefined);
  if (!user) {
    throw new CLIError('Profile response was empty');
  }
  return user;
}

/**
 * Exchange a uak_ PAT for a short-lived JWT via the backend exchange endpoint.
 * The PAT itself is never stored as an access token — we store the JWT and
 * keep the PAT only for silent re-exchange when the JWT expires.
 */
async function exchangePatForJwt(
  apiKey: string,
  apiUrl?: string,
): Promise<{ token: string; user: User }> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const fullUrl = `${baseUrl}/auth/v1/exchange-api-key`;

  let res: Response;
  try {
    res = await fetch(fullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
  } catch (err) {
    throw new CLIError(formatFetchError(err, fullUrl));
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    const msg = body.message ?? body.error ?? `HTTP ${res.status}`;
    throw new CLIError(`API key is invalid or revoked: ${msg}`);
  }

  const data = (await res.json().catch(() => ({}))) as { token?: unknown };
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new CLIError('Exchange endpoint returned an invalid response (missing token).');
  }
  const jwt = data.token;

  // The exchange endpoint returns only the JWT. Fetch the user via /auth/v1/profile
  // using the fresh JWT so we can persist identity in credentials.json.
  let profileRes: Response;
  try {
    profileRes = await fetch(`${baseUrl}/auth/v1/profile`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
  } catch (err) {
    throw new CLIError(formatFetchError(err, `${baseUrl}/auth/v1/profile`));
  }
  if (!profileRes.ok) {
    throw new CLIError(`Exchange succeeded but could not fetch profile: HTTP ${profileRes.status}`);
  }
  const profile = (await profileRes.json().catch(() => null)) as
    | { user?: User }
    | User
    | null;
  const user =
    profile && typeof profile === 'object' && 'user' in profile
      ? (profile as { user?: User }).user
      : ((profile as User | null) ?? undefined);
  if (!user) {
    throw new CLIError('Exchange succeeded but profile response was empty');
  }

  return { token: jwt, user };
}
