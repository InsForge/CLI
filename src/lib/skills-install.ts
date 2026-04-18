import { access, chmod, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type BundledSkillStatus =
  | 'installed'
  | 'updated'
  | 'skipped-exists'
  | 'skipped-keep-local'
  | 'missing-source';

export interface BundledSkillsInstallOptions {
  /** Where to install `insforge-<slug>/SKILL.md` dirs. Defaults to resolveTargetDir(). */
  targetDir?: string;
  /** Where bundled `<slug>/SKILL.md` files live. Defaults to resolveBundledSkillsDir(). */
  skillsSrcDir?: string;
  /** Overwrite existing installs. Mutually exclusive with keepLocal. */
  force?: boolean;
  /** If set, only install skills whose slug is in this list. */
  only?: string[];
  /** If true, existing installs are preserved (reported as skipped-keep-local). */
  keepLocal?: boolean;
}

export interface BundledSkillResult {
  slug: string;
  status: BundledSkillStatus;
  path: string;
  bytes?: number;
}

export interface InstallBundledSkillsResult {
  targetDir: string;
  skillsSrcDir: string;
  results: BundledSkillResult[];
}

export interface BundledSkillEntry {
  slug: string;
  path: string; // absolute path to the SKILL.md source
}

export interface InstalledSkillEntry {
  slug: string;
  path: string; // absolute path to the installed dir (insforge-<slug>)
}

const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

/**
 * Decide where installed skills should live on disk.
 *
 * Precedence:
 *   1. INSFORGE_SKILLS_TARGET_DIR  (test hook / explicit override)
 *   2. CLAUDE_CONFIG_DIR/skills    (matches Claude Code / Desktop)
 *   3. XDG_CONFIG_HOME/claude/skills
 *   4. ~/.claude/skills            (default)
 */
export function resolveTargetDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INSFORGE_SKILLS_TARGET_DIR) return env.INSFORGE_SKILLS_TARGET_DIR;
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, 'skills');
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'claude', 'skills');
  const home = env.HOME ?? homedir();
  return join(home, '.claude', 'skills');
}

/**
 * Locate the `dist/skills/` directory shipped with the compiled CLI.
 *
 * The CLI is bundled with tsup to `dist/index.js`; at publish time we populate
 * `dist/skills/<slug>/SKILL.md` alongside it. When running from source (e.g.
 * during tests), `dist/skills/` may not exist — callers should be prepared
 * for `installBundledSkills` to report `missing-source`.
 */
export function resolveBundledSkillsDir(importMetaUrl?: string): string {
  const here = importMetaUrl ? fileURLToPath(importMetaUrl) : fileURLToPath(import.meta.url);
  // here ~ .../dist/index.js (published) or .../src/lib/skills-install.ts (dev)
  const distCandidate = join(dirname(here), 'skills');
  return distCandidate;
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function listBundledSkills(skillsSrcDir?: string): Promise<BundledSkillEntry[]> {
  const dir = skillsSrcDir ?? resolveBundledSkillsDir();
  if (!(await dirExists(dir))) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const results: BundledSkillEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillFile = join(dir, e.name, 'SKILL.md');
    if (await fileExists(skillFile)) {
      results.push({ slug: e.name, path: skillFile });
    }
  }
  // stable order
  results.sort((a, b) => a.slug.localeCompare(b.slug));
  return results;
}

export async function listInstalledSkills(targetDir?: string): Promise<InstalledSkillEntry[]> {
  const dir = targetDir ?? resolveTargetDir();
  if (!(await dirExists(dir))) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const results: InstalledSkillEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith('insforge-')) continue;
    results.push({
      slug: e.name.slice('insforge-'.length),
      path: join(dir, e.name),
    });
  }
  results.sort((a, b) => a.slug.localeCompare(b.slug));
  return results;
}

export async function uninstallSkill(
  slug: string,
  targetDir?: string,
): Promise<{ removed: boolean; path: string }> {
  const dir = targetDir ?? resolveTargetDir();
  const path = join(dir, `insforge-${slug}`);
  if (!(await dirExists(path))) {
    return { removed: false, path };
  }
  await rm(path, { recursive: true, force: true });
  return { removed: true, path };
}

/**
 * Copy bundled SKILL.md files into `<targetDir>/insforge-<slug>/SKILL.md`.
 *
 * Semantics:
 *   - No existing dir   → copy, status=installed
 *   - Existing + force  → overwrite, status=updated
 *   - Existing + keepLocal → leave alone, status=skipped-keep-local
 *   - Existing + !force && !keepLocal → leave alone, status=skipped-exists
 */
export async function installBundledSkills(
  opts: BundledSkillsInstallOptions = {},
): Promise<InstallBundledSkillsResult> {
  const targetDir = opts.targetDir ?? resolveTargetDir();
  const skillsSrcDir = opts.skillsSrcDir ?? resolveBundledSkillsDir();

  const bundled = await listBundledSkills(skillsSrcDir);
  if (bundled.length === 0) {
    return {
      targetDir,
      skillsSrcDir,
      results: [
        {
          slug: '',
          status: 'missing-source',
          path: skillsSrcDir,
        },
      ],
    };
  }

  await mkdir(targetDir, { recursive: true, mode: DIR_MODE });

  const filter = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  const results: BundledSkillResult[] = [];

  for (const skill of bundled) {
    if (filter && !filter.has(skill.slug)) continue;

    const installedDir = join(targetDir, `insforge-${skill.slug}`);
    const installedFile = join(installedDir, 'SKILL.md');
    const alreadyThere = await dirExists(installedDir);

    if (alreadyThere && opts.keepLocal) {
      results.push({ slug: skill.slug, status: 'skipped-keep-local', path: installedDir });
      continue;
    }
    if (alreadyThere && !opts.force) {
      results.push({ slug: skill.slug, status: 'skipped-exists', path: installedDir });
      continue;
    }

    await mkdir(installedDir, { recursive: true, mode: DIR_MODE });
    // ensure perms (mkdir honors umask; chmod is authoritative)
    await chmod(installedDir, DIR_MODE);
    await copyFile(skill.path, installedFile);
    await chmod(installedFile, FILE_MODE);

    const s = await stat(installedFile);
    results.push({
      slug: skill.slug,
      status: alreadyThere ? 'updated' : 'installed',
      path: installedDir,
      bytes: s.size,
    });
  }

  return { targetDir, skillsSrcDir, results };
}
