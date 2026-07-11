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
    .option('--user-api-key <key>', 'Authenticate with a uak_ user API key')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      // Which auth path was taken — user_api_key logins are the signal the
      // dashboard's connect-agent onboarding funnel is measured by.
      const method = opts.userApiKey ? 'user_api_key' : opts.email ? 'email' : 'oauth';

      try {
        if (opts.userApiKey) {
          await loginWithUserApiKey(opts.userApiKey, json, apiUrl);
        } else if (opts.email) {
          await loginWithEmail(json, apiUrl);
        } else {
          await loginWithOAuth(json, apiUrl);
        }

        await trackTopLevelUsage('login', true, { method });
      } catch (err) {
        if (err instanceof Error && err.message.includes('cancelled')) {
          process.exit(0);
        }
        await trackTopLevelUsage('login', false, { method }, err);
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

/**
 * Log in with a uak_ user API key used DIRECTLY as the bearer credential — no
 * exchange endpoint, no JWT, no refresh cycle. We fetch the profile once
 * (authenticating with the key itself) to validate it and persist identity.
 */
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
  // stay empty so getAccessToken() serves user_api_key, and refresh logic
  // treats this as a non-refreshable direct login (isDirectApiKeyLogin).
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
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    const detail = body.message ?? body.error;
    // Only claim the key itself is bad on an actual auth failure. A 5xx/429
    // (outage, rate limit) must NOT tell the user to rotate a valid key.
    if (res.status === 401 || res.status === 403) {
      throw new CLIError(`API key is invalid or revoked${detail ? `: ${detail}` : ''}`);
    }
    throw new CLIError(`Could not verify API key (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }

  const profile = (await res.json().catch(() => null)) as { user?: User } | User | null;
  const user =
    profile && typeof profile === 'object' && 'user' in profile
      ? (profile as { user?: User }).user
      : ((profile as User | null) ?? undefined);
  // Require a real identity, not just a truthy value: the flat-shape fallback
  // can yield `{}` from an empty body, which would persist a malformed user
  // and print "Authenticated as undefined".
  if (!user?.id) {
    throw new CLIError('Profile response was empty or malformed');
  }
  return user;
}
