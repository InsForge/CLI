import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  composeProjectName,
  clearLocalState,
  ensureLocalGitignore,
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

  it('clearLocalState removes the state file and leaves the checkout alone', () => {
    const cwd = tmp();
    writeLocalState(STATE, cwd);
    // The secrets live in .insforge/checkout/.env now, and the checkout is
    // whole directories of upstream's files — `local stop --delete-data`
    // removes containers and volumes, not the stack definition.
    const checkoutMarker = join(cwd, '.insforge', 'checkout', '.env');
    mkdirSync(dirname(checkoutMarker), { recursive: true });
    writeFileSync(checkoutMarker, 'X=1\n');
    clearLocalState(cwd);
    expect(existsSync(localStateFile(cwd))).toBe(false);
    expect(existsSync(checkoutMarker)).toBe(true);
  });
});

describe('ensureLocalGitignore', () => {
  it('ignores the secrets and state files', () => {
    const cwd = tmp();
    ensureLocalGitignore(cwd);
    const body = readFileSync(join(cwd, '.insforge', '.gitignore'), 'utf-8');
    // checkout/ is where the generated .env lives — the entry that actually
    // keeps the instance's secrets out of a commit.
    expect(body.split('\n')).toContain('checkout/');
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
    expect(lines).toEqual([
      'something-else',
      'checkout/',
      'setup.sh',
      'local.json',
      'project.cloud.json',
    ]);
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

describe('composeProjectName across platforms', () => {
  it('takes the last segment of a Windows path too', () => {
    // split('/') returns the whole string on Windows, so the project name became
    // the entire path flattened — d-users-me-work-app rather than app.
    expect(composeProjectName('C:\\Users\\me\\work\\app')).toMatch(/^insforge-app-[0-9a-f]{8}$/);
    expect(composeProjectName('/home/me/work/app')).toMatch(/^insforge-app-[0-9a-f]{8}$/);
  });

  it('still separates two directories that share a basename', () => {
    expect(composeProjectName('/a/api')).not.toBe(composeProjectName('/b/api'));
  });

  it('falls back when there is no usable segment', () => {
    expect(composeProjectName('/')).toMatch(/^insforge-(app|insforge)-[0-9a-f]{8}$/);
  });
});
