// Apply an auth provider's scaffold to a directory. Overlay-safe: files that
// already exist are left untouched (warned), package.json is deep-merged, and
// .env.example is appended rather than replaced.
//
// Files for each provider live in src/auth-providers/<name>/files/ and are
// shipped to dist/auth-providers/<name>/files/ via the tsup copy step (see
// tsup.config.ts). At runtime we resolve the dist location via import.meta.url.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import * as clack from '@clack/prompts';

import { getAnonKey, getJwtSecret } from '../lib/api/oss.js';
import type { ProjectConfig } from '../types.js';
import { manifest as betterAuthManifest, type AuthProviderManifest } from './better-auth/manifest.js';

export const VALID_AUTH_PROVIDERS = ['better-auth'] as const;
export type AuthProvider = (typeof VALID_AUTH_PROVIDERS)[number];

// Static map. Adding a new provider = add an entry here + a matching
// directory under src/auth-providers/<name>/files/. The dynamic-import
// alternative confuses bundlers since manifest.ts gets bundled, not emitted
// as a sibling .js at runtime.
const MANIFESTS: Record<AuthProvider, AuthProviderManifest> = {
  'better-auth': betterAuthManifest,
};

function loadManifest(provider: AuthProvider): AuthProviderManifest {
  return MANIFESTS[provider];
}

function pathExists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
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

  const manifest = await loadManifest(provider);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Files live at dist/auth-providers/<provider>/files/ at runtime; in tests
  // they're at src/auth-providers/<provider>/files/. Probe both.
  const candidates = [
    path.join(here, provider, 'files'),
    path.join(here, '..', '..', 'src', 'auth-providers', provider, 'files'),
  ];
  let filesRoot: string | null = null;
  for (const c of candidates) {
    if (await pathExists(c)) { filesRoot = c; break; }
  }
  if (!filesRoot) throw new Error(`Auth provider ${provider} files directory not found (tried: ${candidates.join(', ')})`);

  const result: ApplyResult = {
    written: [], skipped: [],
    packageJsonPatched: false, envExampleAppended: false, envLocalWritten: false,
  };

  // 1. Copy files (skip if exists)
  const allFiles = await walkFiles(filesRoot);
  for (const rel of allFiles) {
    const src = path.join(filesRoot, rel);
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

  // 3. Append to .env.example (or create if absent).
  const envExamplePath = path.join(cwd, '.env.example');
  if (await pathExists(envExamplePath)) {
    const existing = await fs.readFile(envExamplePath, 'utf-8');
    if (!existing.includes('# ─── Better Auth + InsForge bridge')) {
      await fs.writeFile(envExamplePath, existing.replace(/\n*$/, '\n\n') + manifest.envExampleAppend + '\n');
      result.envExampleAppended = true;
    }
  } else {
    await fs.writeFile(envExamplePath, manifest.envExampleAppend + '\n');
    result.envExampleAppended = true;
  }

  // 4. Write .env.local with auto-filled values from the appended section.
  //    Mirrors the substitution rules used for templates: INSFORGE_*_URL,
  //    INSFORGE_*_ANON_KEY, NEXT_PUBLIC_APP_URL, *_JWT_SECRET, BETTER_AUTH_SECRET.
  const envLocalPath = path.join(cwd, '.env.local');
  if (!(await pathExists(envLocalPath))) {
    const anonKey = await getAnonKey();
    const jwtSecret = await getJwtSecret();
    const filled = manifest.envExampleAppend.replace(
      /^([A-Z][A-Z0-9_]*=)(.*)$/gm,
      (_, prefix: string, value: string) => {
        const key = prefix.slice(0, -1);
        if (/INSFORGE.*(URL|BASE_URL)$/.test(key)) return `${prefix}${projectConfig.oss_host}`;
        if (/INSFORGE.*ANON_KEY$/.test(key)) return `${prefix}${anonKey}`;
        if (key === 'NEXT_PUBLIC_APP_URL') return `${prefix}https://${projectConfig.appkey}.insforge.site`;
        if (/JWT_SECRET$/.test(key)) {
          return `${prefix}${jwtSecret ?? value}`;
        }
        if (key === 'BETTER_AUTH_SECRET') return `${prefix}${randomBytes(32).toString('hex')}`;
        return `${prefix}${value}`;
      },
    );
    await fs.writeFile(envLocalPath, filled + '\n');
    result.envLocalWritten = true;
    if (!jwtSecret && !json) {
      clack.log.warn('Could not auto-fill JWT_SECRET — run `npx @insforge/cli secrets get JWT_SECRET` and paste it into .env.local.');
    }
  }

  return result;
}

export function getAuthProviderNextSteps(provider: AuthProvider): string {
  return loadManifest(provider).nextSteps;
}
