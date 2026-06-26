import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as clack from '@clack/prompts';
import { fetchApifyAccessToken } from './api/apify-token.js';
import { installProviderSkillPack } from './skills.js';

const execAsync = promisify(exec);

/** Hard ceiling for a single bridge step (npm install / apify login). Generous
 * so a slow global install on a poor connection still finishes, but bounded so
 * a hung child never blocks forever — important in json/agent mode where stdio
 * is silenced and there is no way to Ctrl-C. */
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run a command with inherited stdio (non-json) so the user sees live progress
 * and there is no output-buffer ceiling — unlike buffered `exec`, which can
 * silently fail a big `npm install` on maxBuffer or look frozen. Resolves on
 * exit code 0, rejects otherwise (including timeout).
 *
 * `shell: true` on Windows so `.cmd` shims (`npm`, `apify`) resolve — bare
 * `spawn('npm', ...)` fails with ENOENT there (modern Node also refuses to run
 * `.cmd` without a shell). Callers MUST pass only shell-safe args on this path:
 * the Apify token is charset-validated in `runApifyAuthBridge` before it reaches
 * here, so no shell metacharacter can be injected.
 */
function run(cmd: string, args: string[], json: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: json ? 'ignore' : 'inherit',
      shell: process.platform === 'win32',
      timeout: RUN_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      if (signal) {
        return reject(
          new Error(`\`${cmd} ${args.join(' ')}\` was killed (${signal}) — likely timed out after ${RUN_TIMEOUT_MS / 1000}s.`),
        );
      }
      reject(new Error(`\`${cmd} ${args.join(' ')}\` exited with code ${code}`));
    });
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
    // Apify CLI writes `{ "token": "<token>", ... }`. Prefer an exact field
    // compare over a substring scan of the raw text (more robust against false
    // positives and format drift); fall back to substring only if the shape is
    // unexpected and we cannot parse it.
    try {
      const parsed = JSON.parse(raw) as { token?: unknown };
      if (typeof parsed.token === 'string') {
        return parsed.token === token;
      }
    } catch {
      // not JSON / unexpected shape — fall through to the substring check
    }
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
 * confirmed by reading `~/.apify/auth.json` instead. Also sets APIFY_TOKEN in
 * this process's env so child processes (and apify-client code) can read it.
 * Throws if the login itself did not take effect (fatal); a failed skills
 * install is non-fatal and reported via the returned `skillsInstalled` flag so
 * the caller can warn instead of falsely claiming skills are ready.
 */
export async function runApifyAuthBridge(json: boolean): Promise<{ skillsInstalled: boolean }> {
  const token = await fetchApifyAccessToken();

  // `apify login --token <token>` runs through a shell on Windows (required for
  // the `.cmd` shims). Apify API tokens are `apify_api_<alphanumeric>`, so any
  // character outside this safe set means a corrupt/unexpected token — reject it
  // rather than let a shell metacharacter reach the command line (injection /
  // broken arg parsing). The trusted source (InsForge) should never emit one.
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(
      'Unexpected Apify token format; refusing to pass it to the shell. Re-run `insforge datasource apify connect`.',
    );
  }

  if (!(await hasApifyCli())) {
    if (!json) clack.log.info('Apify CLI not found — installing apify-cli globally...');
    await run('npm', ['install', '-g', 'apify-cli'], json);
  }

  // HARD REQ: always --token; never plain `apify login` (browser OAuth).
  // Do not trust the exit code (see above) — verify via ~/.apify/auth.json.
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
  const skillsInstalled = await installProviderSkillPack(json, 'apify');
  return { skillsInstalled };
}
