import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_REF,
  UPSTREAM_FILES,
  ensureUpstreamFiles,
  upstreamCached,
  upstreamDir,
} from './upstream.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'if-upstream-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function seed(ref: string, cwd: string, body = 'payload\n'): void {
  const dir = upstreamDir(ref, cwd);
  mkdirSync(dir, { recursive: true });
  for (const name of Object.keys(UPSTREAM_FILES)) writeFileSync(join(dir, name), body);
}

describe('UPSTREAM_FILES', () => {
  it('names the files the compose template inlines and the storage overlays', () => {
    expect(Object.keys(UPSTREAM_FILES).sort()).toEqual([
      'db-init.sql',
      'docker-compose.minio.yml',
      'docker-compose.rustfs.yml',
      'server.ts',
      'worker-template.js',
    ]);
  });

  it('points at paths that exist in the InsForge repository', () => {
    // A wrong path here is a 404 at `local start` for every user at once, and
    // the paths are easy to get wrong: db-init.sql sits under deploy/, the Deno
    // host under functions/, the overlays at the root.
    expect(UPSTREAM_FILES['db-init.sql']).toBe('deploy/docker-init/db/db-init.sql');
    expect(UPSTREAM_FILES['server.ts']).toBe('functions/server.ts');
    expect(UPSTREAM_FILES['worker-template.js']).toBe('functions/worker-template.js');
    expect(UPSTREAM_FILES['docker-compose.minio.yml']).toBe('docker-compose.minio.yml');
    for (const p of Object.values(UPSTREAM_FILES)) {
      expect(p.startsWith('/')).toBe(false);
    }
  });
});

describe('upstreamDir', () => {
  it('keys the cache by ref so a version bump re-fetches', () => {
    const cwd = tmp();
    expect(upstreamDir('v2.2.9', cwd)).not.toBe(upstreamDir('v2.3.0', cwd));
    expect(upstreamDir('v2.2.9', cwd).endsWith(join('upstream', 'v2.2.9'))).toBe(true);
  });

  it('keeps a hostile ref inside the cache directory', () => {
    // Not reachable from resolveStackTag today, but --stack-tag takes whatever
    // the user types and this path is passed to mkdirSync.
    const cwd = tmp();
    const cache = join(upstreamDir('x', cwd), '..');
    for (const ref of ['../../etc', '..', '.', '/etc/passwd', '.ssh']) {
      const dir = upstreamDir(ref, cwd);
      // Exactly one level below upstream/, whatever the ref contained: a name
      // may hold dots, but its parent has to be the cache directory itself.
      expect(dirname(resolve(dir))).toBe(resolve(cache));
      expect(resolve(dir)).not.toBe(resolve(cache));
    }
  });
});

describe('upstreamCached', () => {
  it('is false until every file is present', () => {
    const cwd = tmp();
    expect(upstreamCached('v1', cwd)).toBe(false);
    const dir = upstreamDir('v1', cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'db-init.sql'), 'x\n');
    expect(upstreamCached('v1', cwd)).toBe(false);
    seed('v1', cwd);
    expect(upstreamCached('v1', cwd)).toBe(true);
  });

  it('treats an empty file as absent', () => {
    // A fetch that returned 200 with no body, or a write that was interrupted,
    // would otherwise render a config carrying nothing.
    const cwd = tmp();
    seed('v1', cwd);
    writeFileSync(join(upstreamDir('v1', cwd), 'server.ts'), '   \n');
    expect(upstreamCached('v1', cwd)).toBe(false);
  });
});

describe('ensureUpstreamFiles', () => {
  it('makes no request when the ref is already cached', async () => {
    const cwd = tmp();
    seed('v2.2.9', cwd);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(ensureUpstreamFiles('v2.2.9', cwd)).resolves.toBe(upstreamDir('v2.2.9', cwd));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches each file from raw.githubusercontent.com at the given ref', async () => {
    const cwd = tmp();
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return { ok: true, status: 200, statusText: 'OK', text: async () => `body of ${url}\n` };
      }),
    );
    const dir = await ensureUpstreamFiles('v2.2.9', cwd);
    expect(urls).toHaveLength(Object.keys(UPSTREAM_FILES).length);
    for (const u of urls) {
      expect(u.startsWith('https://raw.githubusercontent.com/InsForge/InsForge/v2.2.9/')).toBe(true);
    }
    expect(readFileSync(join(dir, 'server.ts'), 'utf-8')).toContain('functions/server.ts');
    expect(upstreamCached('v2.2.9', cwd)).toBe(true);
  });

  it('reports the ref and every file that failed, and names the reason', async () => {
    const cwd = tmp();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' })),
    );
    await expect(ensureUpstreamFiles('v0.0.0', cwd)).rejects.toThrow(/at v0\.0\.0/);
    await expect(ensureUpstreamFiles('v0.0.0', cwd)).rejects.toThrow(/404/);
    await expect(ensureUpstreamFiles('v0.0.0', cwd)).rejects.toThrow(/raw\.githubusercontent\.com/);
  });

  it('rejects an empty 200 rather than caching it', async () => {
    const cwd = tmp();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '\n' })),
    );
    await expect(ensureUpstreamFiles('v1', cwd)).rejects.toThrow(/empty response/);
    expect(upstreamCached('v1', cwd)).toBe(false);
  });

  it('keeps files already fetched when a later one fails', async () => {
    // A partial cache must not read as complete on the next start, but the files
    // that did arrive are worth keeping so a retry fetches less.
    const cwd = tmp();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n > 1) return { ok: false, status: 500, statusText: 'Server Error', text: async () => '' };
        return { ok: true, status: 200, statusText: 'OK', text: async () => 'first\n' };
      }),
    );
    await expect(ensureUpstreamFiles('v1', cwd)).rejects.toThrow();
    expect(upstreamCached('v1', cwd)).toBe(false);
    const arrived = Object.keys(UPSTREAM_FILES).filter((f) =>
      existsSync(join(upstreamDir('v1', cwd), f)),
    );
    expect(arrived.length).toBe(1);
  });
});

describe('DEFAULT_REF', () => {
  it('is main, which is what the :latest images are built from', () => {
    expect(DEFAULT_REF).toBe('main');
  });
});
