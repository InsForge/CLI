import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import * as prompts from '../lib/prompts.js';
import { saveCredentials, getPlatformApiUrl } from '../lib/config.js';
import { login as platformLogin } from '../lib/api/platform.js';
import { performOAuthLogin } from '../lib/auth.js';
import { handleError, getRootOpts, CLIError, formatFetchError } from '../lib/errors.js';
import type { StoredCredentials, User } from '../types.js';

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with InsForge platform')
    .option('--email', 'Login with email and password instead of browser')
    .option('--user-api-key <key>', 'Authenticate with a user API key (uak_...) — skips OAuth')
    .option('--client-id <id>', 'OAuth client ID (defaults to insforge-cli)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);

      try {
        if (opts.userApiKey) {
          await loginWithUserApiKey(opts.userApiKey, json, apiUrl);
        } else if (opts.email) {
          await loginWithEmail(json, apiUrl);
        } else {
          await loginWithOAuth(json, apiUrl);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('cancelled')) {
          process.exit(0);
        }
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

// Verifies the PAT by calling /auth/v1/profile directly with the key as
// Bearer — bypasses platformFetch so the existing credentials on disk stay
// untouched until we know the key is good. Returns the profile on success;
// throws on any failure.
async function verifyUserApiKey(key: string, apiUrl?: string): Promise<User> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const fullUrl = `${baseUrl}/auth/v1/profile`;
  let res: Response;
  try {
    res = await fetch(fullUrl, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
    });
  } catch (err) {
    throw new CLIError(formatFetchError(err, fullUrl));
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; message?: string };
    const msg = body.message ?? body.error ?? `HTTP ${res.status}`;
    throw new Error(`API key is invalid or revoked: ${msg}`);
  }
  const data = (await res.json()) as { user?: User };
  return data.user ?? (data as unknown as User);
}

async function loginWithUserApiKey(key: string, json: boolean, apiUrl?: string): Promise<void> {
  if (!key.startsWith('uak_')) {
    throw new Error('Invalid API key — must start with "uak_".');
  }

  // Verify the key BEFORE touching ~/.insforge/credentials.json so a mistyped
  // or revoked key doesn't blow away the user's existing OAuth session.
  const s = !json ? clack.spinner() : null;
  s?.start('Verifying API key...');
  let profile: User;
  try {
    profile = await verifyUserApiKey(key, apiUrl);
  } catch (err) {
    s?.stop('API key verification failed');
    throw err instanceof Error
      ? new Error(err.message, { cause: err })
      : new Error(String(err));
  }

  // Verified — now persist.
  const creds: StoredCredentials = {
    access_token: key,
    refresh_token: '',
    user: profile,
  };
  saveCredentials(creds);

  if (!json) {
    s?.stop(`Authenticated as ${profile.email}`);
    clack.outro('Done');
  } else {
    console.log(JSON.stringify({ success: true, user: profile }));
  }
}
