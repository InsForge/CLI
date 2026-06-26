import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as clack from '@clack/prompts';
import { fetchApifyAccessToken } from './api/apify-token.js';
import { installProviderSkillPack } from './skills.js';

const execAsync = promisify(exec);

/**
 * Run a command with inherited stdio (non-json) so the user sees live progress
 * and there is no output-buffer ceiling — unlike buffered `exec`, which can
 * silently fail a big `npm install` on maxBuffer or look frozen. Resolves on
 * exit code 0, rejects otherwise.
 */
function run(cmd: string, args: string[], json: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: json ? 'ignore' : 'inherit' });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`\`${cmd} ${args.join(' ')}\` exited with code ${code}`)),
    );
  });
}

async function hasApifyCli(): Promise<boolean> {
  try {
    await execAsync('apify --version', { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * True if `apify login --token` actually persisted the credential. Reads
 * `~/.apify/auth.json` directly instead of running `apify info`, whose exit
 * code (like `apify login`'s) is unreliable in a non-TTY shell and produced a
 * false "login did not take effect" failure.
 */
async function isApifyLoggedIn(token: string): Promise<boolean> {
  try {
    const raw = await readFile(join(homedir(), '.apify', 'auth.json'), 'utf8');
    return raw.includes(token);
  } catch {
    return false;
  }
}

/**
 * Auth bridge shared by `datasource apify connect` and `datasource apify
 * login`:
 *
 * 1. fetch the InsForge-managed Apify access token,
 * 2. ensure the Apify CLI is installed (visible progress; no buffer ceiling),
 * 3. `apify login --token` (HARD REQ: never the browser OAuth flow),
 * 4. install Apify's official agent skills.
 *
 * `apify login --token` can exit non-zero in a non-TTY shell even when the
 * login actually succeeds, so its exit code is not trusted — success is
 * confirmed with `apify info` instead. Also sets APIFY_TOKEN in this process's
 * env so child processes (and apify-client code) can read it. Throws on real
 * failure — callers decide whether that is fatal (connect degrades gracefully;
 * login surfaces the error).
 */
export async function runApifyAuthBridge(json: boolean): Promise<void> {
  const token = await fetchApifyAccessToken();

  if (!(await hasApifyCli())) {
    if (!json) clack.log.info('Apify CLI not found — installing apify-cli globally...');
    await run('npm', ['install', '-g', 'apify-cli'], json);
  }

  // HARD REQ: always --token; never plain `apify login` (browser OAuth).
  // Do not trust the exit code (see above) — verify with `apify info`.
  try {
    await run('apify', ['login', '--token', token], json);
  } catch {
    // fall through to verification
  }
  if (!(await isApifyLoggedIn(token))) {
    throw new Error('Apify login did not take effect. Re-run `insforge datasource apify login`.');
  }

  process.env.APIFY_TOKEN = token;
  // Only the Apify skill pack — do not reinstall the main InsForge skills.
  await installProviderSkillPack(json, 'apify');
}
