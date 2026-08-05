import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeProjectName,
  clearLocalState,
  ensureLocalGitignore,
  localEnvFile,
  localStateFile,
  readLocalState,
  writeLocalState,
  type LocalState,
} from './state.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'if-local-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const STATE: LocalState = {
  version: 1,
  projectName: 'insforge-app-abc12345',
  stackTag: 'v2.2.9',
  storage: 'local',
  ports: { app: 7130, auth: 7131, deno: 7133, postgres: 5432, postgrest: 5430 },
  createdAt: '2026-08-05T00:00:00.000Z',
};

describe('composeProjectName', () => {
  it('gives two directories with the same basename different names', () => {
    // Without the path hash, ~/a/api and ~/b/api would share containers and one
    // would silently attach to the other's database.
    expect(composeProjectName('/home/u/a/api')).not.toBe(composeProjectName('/home/u/b/api'));
  });

  it('is stable for the same directory', () => {
    expect(composeProjectName('/home/u/app')).toBe(composeProjectName('/home/u/app'));
  });

  it('produces a docker-legal project name', () => {
    for (const dir of ['/tmp/My App!', '/tmp/___weird', '/tmp/9lives', '/']) {
      expect(composeProjectName(dir)).toMatch(/^insforge-[a-z0-9][a-z0-9_-]*$/);
    }
  });
});

describe('local state file', () => {
  it('round-trips', () => {
    const cwd = tmp();
    writeLocalState(STATE, cwd);
    expect(readLocalState(cwd)).toEqual(STATE);
  });

  it('returns null when absent', () => {
    expect(readLocalState(tmp())).toBeNull();
  });

  it('returns null on a corrupt file rather than throwing', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.insforge'), { recursive: true });
    writeFileSync(localStateFile(cwd), '{not json');
    expect(readLocalState(cwd)).toBeNull();
  });

  it('clearLocalState removes both state and secrets', () => {
    const cwd = tmp();
    writeLocalState(STATE, cwd);
    writeFileSync(localEnvFile(cwd), 'JWT_SECRET=x\n');
    clearLocalState(cwd);
    expect(existsSync(localStateFile(cwd))).toBe(false);
    expect(existsSync(localEnvFile(cwd))).toBe(false);
  });
});

describe('ensureLocalGitignore', () => {
  it('ignores the secrets and state files', () => {
    const cwd = tmp();
    ensureLocalGitignore(cwd);
    const body = readFileSync(join(cwd, '.insforge', '.gitignore'), 'utf-8');
    expect(body.split('\n')).toContain('local.env');
    expect(body.split('\n')).toContain('local.json');
  });

  it('is idempotent and preserves existing entries', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.insforge'), { recursive: true });
    writeFileSync(join(cwd, '.insforge', '.gitignore'), 'something-else\n');
    ensureLocalGitignore(cwd);
    ensureLocalGitignore(cwd);
    const lines = readFileSync(join(cwd, '.insforge', '.gitignore'), 'utf-8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toEqual(['something-else', 'local.env', 'local.json', 'local-db-init.sql']);
  });

  // project.json holds a cloud api_key and is not ours to start ignoring.
  it('does not ignore project.json', () => {
    const cwd = tmp();
    ensureLocalGitignore(cwd);
    const body = readFileSync(join(cwd, '.insforge', '.gitignore'), 'utf-8');
    expect(body).not.toContain('project.json');
    expect(body).not.toMatch(/^\*$/m);
  });
});
