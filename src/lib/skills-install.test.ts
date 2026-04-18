import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installBundledSkills,
  listBundledSkills,
  listInstalledSkills,
  resolveTargetDir,
  uninstallSkill,
} from './skills-install.js';

async function makeFixtureBundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'insforge-skills-src-'));
  await mkdir(join(dir, 'alpha'), { recursive: true });
  await writeFile(join(dir, 'alpha', 'SKILL.md'), '# alpha\nHello alpha.\n', { mode: 0o644 });
  await mkdir(join(dir, 'beta'), { recursive: true });
  await writeFile(join(dir, 'beta', 'SKILL.md'), '# beta\nHello beta.\n', { mode: 0o644 });
  return dir;
}

describe('resolveTargetDir', () => {
  it('honors INSFORGE_SKILLS_TARGET_DIR first (test hook)', () => {
    expect(
      resolveTargetDir({
        INSFORGE_SKILLS_TARGET_DIR: '/tmp/override',
        CLAUDE_CONFIG_DIR: '/should-be-ignored',
        XDG_CONFIG_HOME: '/also-ignored',
        HOME: '/home/user',
      }),
    ).toBe('/tmp/override');
  });

  it('falls back to CLAUDE_CONFIG_DIR/skills when set', () => {
    expect(
      resolveTargetDir({
        CLAUDE_CONFIG_DIR: '/custom/claude',
        HOME: '/home/user',
      }),
    ).toBe('/custom/claude/skills');
  });

  it('falls back to XDG_CONFIG_HOME/claude/skills when CLAUDE_CONFIG_DIR is unset', () => {
    expect(
      resolveTargetDir({
        XDG_CONFIG_HOME: '/xdg',
        HOME: '/home/user',
      }),
    ).toBe('/xdg/claude/skills');
  });

  it('defaults to ~/.claude/skills when no env vars are set', () => {
    const result = resolveTargetDir({ HOME: '/home/user' });
    expect(result).toBe('/home/user/.claude/skills');
  });
});

describe('installBundledSkills', () => {
  let srcDir: string;
  let targetDir: string;

  beforeEach(async () => {
    srcDir = await makeFixtureBundle();
    targetDir = await mkdtemp(join(tmpdir(), 'insforge-skills-target-'));
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  });

  it('copies each bundled skill into insforge-<slug>/SKILL.md with 0644 perms', async () => {
    const res = await installBundledSkills({ skillsSrcDir: srcDir, targetDir });

    expect(res.results.map((r) => r.slug).sort()).toEqual(['alpha', 'beta']);
    expect(res.results.every((r) => r.status === 'installed')).toBe(true);

    const alphaPath = join(targetDir, 'insforge-alpha', 'SKILL.md');
    const betaPath = join(targetDir, 'insforge-beta', 'SKILL.md');

    const alphaContent = await readFile(alphaPath, 'utf-8');
    expect(alphaContent).toContain('Hello alpha');

    const alphaStat = await stat(alphaPath);
    expect(alphaStat.mode & 0o777).toBe(0o644);

    const alphaDirStat = await stat(join(targetDir, 'insforge-alpha'));
    expect(alphaDirStat.mode & 0o777).toBe(0o755);

    expect((await readFile(betaPath, 'utf-8'))).toContain('Hello beta');
  });

  it('skips already-installed skills on a plain re-run (no force)', async () => {
    await installBundledSkills({ skillsSrcDir: srcDir, targetDir });

    // mutate the installed file to prove we don't overwrite
    const alphaPath = join(targetDir, 'insforge-alpha', 'SKILL.md');
    await writeFile(alphaPath, '# local edit\n');

    const res = await installBundledSkills({ skillsSrcDir: srcDir, targetDir });
    expect(res.results.every((r) => r.status === 'skipped-exists')).toBe(true);

    const after = await readFile(alphaPath, 'utf-8');
    expect(after).toBe('# local edit\n');
  });

  it('overwrites when force is true', async () => {
    await installBundledSkills({ skillsSrcDir: srcDir, targetDir });

    const alphaPath = join(targetDir, 'insforge-alpha', 'SKILL.md');
    await writeFile(alphaPath, '# local edit\n');

    const res = await installBundledSkills({ skillsSrcDir: srcDir, targetDir, force: true });
    expect(res.results.every((r) => r.status === 'installed' || r.status === 'updated')).toBe(true);

    const after = await readFile(alphaPath, 'utf-8');
    expect(after).toContain('Hello alpha');
  });

  it('honors keepLocal: skipped-keep-local on existing, installed on missing', async () => {
    await installBundledSkills({ skillsSrcDir: srcDir, targetDir, only: ['alpha'] });

    const res = await installBundledSkills({ skillsSrcDir: srcDir, targetDir, keepLocal: true });
    const byStatus = Object.fromEntries(res.results.map((r) => [r.slug, r.status]));
    expect(byStatus.alpha).toBe('skipped-keep-local');
    expect(byStatus.beta).toBe('installed');
  });

  it('honors `only` filter', async () => {
    const res = await installBundledSkills({ skillsSrcDir: srcDir, targetDir, only: ['beta'] });
    expect(res.results.map((r) => r.slug)).toEqual(['beta']);

    const entries = await readdir(targetDir);
    expect(entries).toEqual(['insforge-beta']);
  });

  it('returns a single missing-source result when the bundle dir is empty', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'insforge-skills-empty-'));
    try {
      const res = await installBundledSkills({ skillsSrcDir: empty, targetDir });
      expect(res.results).toHaveLength(1);
      expect(res.results[0].status).toBe('missing-source');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('returns a single missing-source result when the bundle dir does not exist', async () => {
    const res = await installBundledSkills({
      skillsSrcDir: join(srcDir, 'does-not-exist'),
      targetDir,
    });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].status).toBe('missing-source');
  });
});

describe('listBundledSkills / listInstalledSkills / uninstallSkill', () => {
  let srcDir: string;
  let targetDir: string;

  beforeEach(async () => {
    srcDir = await makeFixtureBundle();
    targetDir = await mkdtemp(join(tmpdir(), 'insforge-skills-target-'));
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  });

  it('lists bundled skills by slug, ignoring unrelated entries', async () => {
    // noise: a file at the root, a dir with no SKILL.md
    await writeFile(join(srcDir, 'README.md'), 'noise');
    await mkdir(join(srcDir, 'not-a-skill'), { recursive: true });

    const list = await listBundledSkills(srcDir);
    expect(list.map((s) => s.slug).sort()).toEqual(['alpha', 'beta']);
  });

  it('lists installed skills under insforge- prefix only', async () => {
    await installBundledSkills({ skillsSrcDir: srcDir, targetDir });
    // drop a non-insforge-prefixed dir to prove filtering
    await mkdir(join(targetDir, 'other-skill'), { recursive: true });

    const installed = await listInstalledSkills(targetDir);
    expect(installed.map((s) => s.slug).sort()).toEqual(['alpha', 'beta']);
  });

  it('uninstallSkill removes the installed dir and reports removed=true', async () => {
    await installBundledSkills({ skillsSrcDir: srcDir, targetDir });

    const res = await uninstallSkill('alpha', targetDir);
    expect(res.removed).toBe(true);

    const entries = await readdir(targetDir);
    expect(entries).toEqual(['insforge-beta']);

    // Second uninstall is a no-op
    const again = await uninstallSkill('alpha', targetDir);
    expect(again.removed).toBe(false);
  });
});
