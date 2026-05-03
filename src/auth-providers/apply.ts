// Apply an auth provider's scaffold to a directory. Overlay-safe: files that
// already exist are left untouched (warned), package.json is deep-merged, and
// .env.example is appended rather than replaced.
//
// Auth-provider scaffolds live in the InsForge templates repo under
// `auth-providers/<provider>/` — they are NOT regular templates and never
// appear in the CLI's `create` template picker. This function shallow-clones
// the templates repo to a tempdir, reads `manifest.json` from the provider
// directory, then runs the overlay engine (file copy, package.json deep-merge,
// .env.example/.env.local collision-resolved append). Cleans up tempdir on
// completion.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import * as clack from '@clack/prompts';

import { getAnonKey, getJwtSecret } from '../lib/api/oss.js';
import type { ProjectConfig } from '../types.js';

const execFileAsync = promisify(execFile);

export const VALID_AUTH_PROVIDERS = ['better-auth'] as const;
export type AuthProvider = (typeof VALID_AUTH_PROVIDERS)[number];

// Shape of the manifest.json shipped alongside each provider's files in the
// templates repo. Keep this in sync with auth-providers/<name>/manifest.json
// schema there.
interface AuthProviderManifest {
  name: string;
  description?: string;
  files: string[];
  packageJsonPatch: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  envExampleAppend: string;
  nextSteps: string;
}

function pathExists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

// Deep-merge two plain objects. The base wins on key collisions for primitive
// values — i.e. if the user already has "better-auth": "^1.5.0" in their deps,
// we don't downgrade them to "^1.6.0" from our manifest. Nested objects
// recurse. Arrays are not deep-merged (auth provider patches don't use them).
function deepMergeKeepBase<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (
      v && typeof v === 'object' && !Array.isArray(v) &&
      out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])
    ) {
      out[k] = deepMergeKeepBase(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (out[k] === undefined) {
      out[k] = v;
    }
    // else: base has a primitive at this key — preserve it
  }
  return out as T;
}

interface ApplyResult {
  written: string[];
  skipped: string[];
  packageJsonPatched: boolean;
  envExampleAppended: boolean;
  envLocalWritten: boolean;
  envKeysSkipped: string[];
  nextSteps: string;
}

// Parse `KEY=...` lines from a dotenv blob and return the set of defined keys.
// Comments and blank lines are ignored. Quoted values, leading `export `, and
// inline `#` comments don't matter — we only care about the LHS.
// Exported for unit testing.
export function extractEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split('\n')) {
    const trimmed = line.replace(/^\s*export\s+/, '').trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

// Remove any `KEY=value` lines from `append` whose KEY already appears in
// `existingKeys`. Comments and blank lines are kept verbatim so the section
// header survives even if every var below it collides. Returns the filtered
// blob plus the list of keys we dropped (for telemetry / user warning).
// Exported for unit testing.
export function filterCollidingEnvLines(append: string, existingKeys: Set<string>): { filtered: string; dropped: string[] } {
  const dropped: string[] = [];
  const out: string[] = [];
  for (const line of append.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && existingKeys.has(m[1])) {
      dropped.push(m[1]);
      continue;
    }
    out.push(line);
  }
  return { filtered: out.join('\n'), dropped };
}

async function walkFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

// Files in the cloned auth-providers/<name>/ directory that are NOT part of
// the scaffold — they describe the overlay rather than belonging in the
// user's project.
const PROVIDER_META_FILES = new Set(['manifest.json', 'README.md']);

// INSFORGE_TEMPLATES_REPO and INSFORGE_TEMPLATES_BRANCH are escape hatches for
// development against unmerged template branches. They are passed to git via
// execFile's argv (no shell), but we still validate them so an env var can't
// inject a `--upload-pack` or other git option that consumes the next argv.
const SAFE_REPO_PATTERN = /^(https?:\/\/|git@)[A-Za-z0-9._:/@~+-]+(\.git)?$/;
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;

// Shallow-clone the templates repo and return the path to
// `auth-providers/<provider>/`.
async function fetchProviderTree(provider: AuthProvider): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const tempDir = path.join(tmpdir(), `insforge-auth-${provider}-${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });
  const cleanup = () => fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);

  try {
    const repo = process.env.INSFORGE_TEMPLATES_REPO ?? 'https://github.com/InsForge/insforge-templates.git';
    if (!SAFE_REPO_PATTERN.test(repo)) {
      throw new Error(`INSFORGE_TEMPLATES_REPO has unsupported characters: ${repo}`);
    }
    const branch = process.env.INSFORGE_TEMPLATES_BRANCH;
    if (branch !== undefined && !SAFE_BRANCH_PATTERN.test(branch)) {
      throw new Error(`INSFORGE_TEMPLATES_BRANCH has unsupported characters: ${branch}`);
    }

    const args = ['clone', '--depth', '1'];
    if (branch) args.push('-b', branch);
    args.push('--', repo, '.');
    await execFileAsync('git', args, {
      cwd: tempDir,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });

    const providerDir = path.join(tempDir, 'auth-providers', provider);
    if (!(await pathExists(providerDir))) {
      await cleanup();
      throw new Error(
        `Auth provider "${provider}" not found in templates repo. ` +
        `Looked for auth-providers/${provider}/ in ${repo}${branch ? ` (branch: ${branch})` : ''}.`,
      );
    }
    return { dir: providerDir, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function loadManifest(providerDir: string): Promise<AuthProviderManifest> {
  const manifestPath = path.join(providerDir, 'manifest.json');
  if (!(await pathExists(manifestPath))) {
    throw new Error(`Missing manifest.json in ${providerDir}`);
  }
  return JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as AuthProviderManifest;
}

export async function applyAuthProvider(
  provider: AuthProvider,
  cwd: string,
  projectConfig: ProjectConfig,
  json: boolean,
): Promise<ApplyResult> {
  if (!VALID_AUTH_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown auth provider: ${provider}`);
  }

  const fetchSpinner = !json ? clack.spinner() : null;
  fetchSpinner?.start(`Fetching ${provider} scaffold from templates repo...`);
  const { dir: providerDir, cleanup } = await fetchProviderTree(provider);
  fetchSpinner?.stop(`${provider} scaffold ready`);

  try {
    const manifest = await loadManifest(providerDir);

    const result: ApplyResult = {
      written: [], skipped: [],
      packageJsonPatched: false, envExampleAppended: false, envLocalWritten: false,
      envKeysSkipped: [],
      nextSteps: manifest.nextSteps,
    };

    // 1. Copy files (skip if exists). Walk the provider tree and exclude
    //    overlay-meta files (manifest.json, README.md).
    const allFiles = (await walkFiles(providerDir)).filter((rel) => !PROVIDER_META_FILES.has(rel));
    for (const rel of allFiles) {
      const src = path.join(providerDir, rel);
      const dest = path.join(cwd, rel);
      if (await pathExists(dest)) { result.skipped.push(rel); continue; }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      result.written.push(rel);
    }

    // 2. Deep-merge package.json (preserve user's existing values).
    const pkgPath = path.join(cwd, 'package.json');
    if (await pathExists(pkgPath)) {
      const existing = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as Record<string, unknown>;
      const merged = deepMergeKeepBase(existing, manifest.packageJsonPatch);
      await fs.writeFile(pkgPath, JSON.stringify(merged, null, 2) + '\n');
      result.packageJsonPatched = true;
    } else {
      // Fresh project (no package.json yet): create a minimal one.
      const fresh: Record<string, unknown> = {
        name: path.basename(cwd),
        version: '0.0.1',
        private: true,
        ...manifest.packageJsonPatch,
      };
      await fs.writeFile(pkgPath, JSON.stringify(fresh, null, 2) + '\n');
      result.packageJsonPatched = true;
    }

    // 3. Append to .env.example (or create if absent). On collision, the
    //    user's existing key wins — drop our line silently and report it
    //    via envKeysSkipped so the caller can warn.
    const envExamplePath = path.join(cwd, '.env.example');
    if (await pathExists(envExamplePath)) {
      const existing = await fs.readFile(envExamplePath, 'utf-8');
      if (!existing.includes('# ─── Better Auth + InsForge bridge')) {
        const existingKeys = extractEnvKeys(existing);
        const { filtered, dropped } = filterCollidingEnvLines(manifest.envExampleAppend, existingKeys);
        result.envKeysSkipped = dropped;
        await fs.writeFile(envExamplePath, existing.replace(/\n*$/, '\n\n') + filtered + '\n');
        result.envExampleAppended = true;
      }
    } else {
      await fs.writeFile(envExamplePath, manifest.envExampleAppend + '\n');
      result.envExampleAppended = true;
    }

    // 4. Write/extend .env.local with auto-filled values. Substitution rules:
    //    INSFORGE_*_URL, INSFORGE_*_ANON_KEY, NEXT_PUBLIC_APP_URL, *_JWT_SECRET,
    //    BETTER_AUTH_SECRET. If .env.local already exists we APPEND only the
    //    keys it doesn't already define — same base-wins rule as .env.example.
    const envLocalPath = path.join(cwd, '.env.local');
    const envLocalExists = await pathExists(envLocalPath);
    const existingLocal = envLocalExists ? await fs.readFile(envLocalPath, 'utf-8') : '';
    const existingLocalKeys = envLocalExists ? extractEnvKeys(existingLocal) : new Set<string>();

    const anonKey = await getAnonKey();
    const jwtSecret = await getJwtSecret();
    const filled = manifest.envExampleAppend.replace(
      /^([A-Z][A-Z0-9_]*=)(.*)$/gm,
      (_, prefix: string, value: string) => {
        const key = prefix.slice(0, -1);
        if (/INSFORGE.*(URL|BASE_URL)$/.test(key)) return `${prefix}${projectConfig.oss_host}`;
        if (/INSFORGE.*ANON_KEY$/.test(key)) return `${prefix}${anonKey}`;
        if (key === 'NEXT_PUBLIC_APP_URL') return `${prefix}https://${projectConfig.appkey}.insforge.site`;
        if (/JWT_SECRET$/.test(key)) return `${prefix}${jwtSecret ?? value}`;
        if (key === 'BETTER_AUTH_SECRET') return `${prefix}${randomBytes(32).toString('hex')}`;
        return `${prefix}${value}`;
      },
    );

    if (!envLocalExists) {
      await fs.writeFile(envLocalPath, filled + '\n');
      result.envLocalWritten = true;
    } else {
      const { filtered, dropped } = filterCollidingEnvLines(filled, existingLocalKeys);
      const hasNewKey = filtered.split('\n').some((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
      if (hasNewKey) {
        await fs.writeFile(envLocalPath, existingLocal.replace(/\n*$/, '\n\n') + filtered + '\n');
        result.envLocalWritten = true;
      }
      result.envKeysSkipped = Array.from(new Set([...result.envKeysSkipped, ...dropped]));
    }

    if (!jwtSecret && !json) {
      clack.log.warn('Could not auto-fill JWT_SECRET — run `npx @insforge/cli secrets get JWT_SECRET` and paste it into .env.local.');
    }

    if (result.envKeysSkipped.length > 0 && !json) {
      clack.log.warn(
        `Kept your existing values for: ${result.envKeysSkipped.join(', ')}. ` +
        `If any of these need the auth-provider's defaults, see .env.example for reference.`,
      );
    }

    return result;
  } finally {
    await cleanup();
  }
}
