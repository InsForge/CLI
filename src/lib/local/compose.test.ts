import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { assetsDir, composeArgs, composeFiles, parsePsJson } from './compose.js';

describe('assetsDir', () => {
  it('finds the bundled compose files', () => {
    expect(existsSync(`${assetsDir()}/docker-compose.yml`)).toBe(true);
  });
});

describe('composeFiles', () => {
  it('is base-only for filesystem storage', () => {
    const files = composeFiles('local');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/docker-compose\.yml$/);
  });

  it('overlays the store, base first so its env wins the merge order', () => {
    for (const [backend, suffix] of [
      ['minio', 'docker-compose.minio.yml'],
      ['rustfs', 'docker-compose.rustfs.yml'],
    ] as const) {
      const files = composeFiles(backend);
      expect(files).toHaveLength(2);
      expect(files[0]).toMatch(/docker-compose\.yml$/);
      expect(files[1].endsWith(suffix)).toBe(true);
      expect(existsSync(files[1])).toBe(true);
    }
  });
});

describe('composeArgs', () => {
  it('pins the compose project so instances stay per-directory', () => {
    const args = composeArgs({ projectName: 'insforge-app-abc12345', storage: 'local' }, ['up', '-d']);
    expect(args[0]).toBe('compose');
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('insforge-app-abc12345');
    expect(args.slice(-2)).toEqual(['up', '-d']);
  });

  it('passes the generated env file', () => {
    const args = composeArgs({ projectName: 'p', storage: 'local', cwd: '/tmp/x' }, ['ps']);
    expect(args[args.indexOf('--env-file') + 1]).toBe('/tmp/x/.insforge/local.env');
  });
});

describe('parsePsJson', () => {
  it('reads the line-delimited form', () => {
    const out = parsePsJson(
      '{"Service":"postgres","State":"running","Status":"Up 2m","Health":"healthy"}\n' +
        '{"Service":"insforge","State":"running","Status":"Up 1m","Health":""}\n',
    );
    expect(out).toEqual([
      { service: 'postgres', state: 'running', status: 'Up 2m', health: 'healthy' },
      { service: 'insforge', state: 'running', status: 'Up 1m', health: '' },
    ]);
  });

  it('reads the single-array form emitted by newer compose', () => {
    const out = parsePsJson('[{"Service":"deno","State":"exited","Status":"Exited (1)"}]');
    expect(out).toEqual([
      { service: 'deno', state: 'exited', status: 'Exited (1)', health: '' },
    ]);
  });

  it('returns an empty list for no output', () => {
    expect(parsePsJson('')).toEqual([]);
    expect(parsePsJson('   \n')).toEqual([]);
  });

  it('skips a malformed line instead of losing the whole listing', () => {
    const out = parsePsJson('{"Service":"a","State":"running"}\nnot json\n');
    expect(out.map((s) => s.service)).toEqual(['a']);
  });
});
