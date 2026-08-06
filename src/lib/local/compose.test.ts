import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { assetsDir, bundledDbInitSql, composeArgs, composeFiles, parsePsJson } from './compose.js';

describe('assetsDir', () => {
  it('finds the bundled compose files', () => {
    expect(existsSync(`${assetsDir()}/docker-compose.yml`)).toBe(true);
  });
});

describe('bundledDbInitSql', () => {
  it('ships the init SQL that creates the PostgREST roles', () => {
    const sql = readFileSync(bundledDbInitSql(), 'utf-8');
    // PostgREST runs with PGRST_DB_ANON_ROLE=anon and starts before the backend
    // migrates, so these roles have to come from cluster init.
    expect(sql).toContain('CREATE ROLE anon');
    expect(sql).toContain('CREATE ROLE authenticated');
    expect(sql).toContain('CREATE ROLE project_admin');
  });
});

describe('composeFiles', () => {
  it('is the CLI\u2019s own single file for filesystem storage', () => {
    const files = composeFiles('local');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/docker-compose\.yml$/);
  });

  it('appends the storage overlay so it wins the merge', () => {
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

  it('mounts nothing relative to itself', () => {
    // The bug that killed the previous upstream-copy approach: `../docker-init/db/x`
    // resolves next to this file, inside the npm package, where it does not exist.
    const body = readFileSync(composeFiles('local')[0], 'utf-8');
    const relative = body
      .split('\n')
      .filter((l) => /^\s+- (\.|\.\.)\//.test(l));
    expect(relative).toEqual([]);
  });

  it('carries the settings and images local instances need', () => {
    const body = readFileSync(composeFiles('local')[0], 'utf-8');
    const images = body.split('\n').filter((l) => l.trim().startsWith('image:')).join('\n');
    expect(images).toContain('ghcr.io/insforge/postgres:v15.13.4');
    expect(images).not.toContain('postgres-all');
    // Official Deno image, not a hand-built ghcr.io/insforge/deno-runtime.
    expect(images).toContain('denoland/deno:');
    expect(images).not.toContain('deno-runtime');
    // Edge functions 502 without this; it was missing upstream.
    expect(body).toContain('DENO_RUNTIME_URL: http://deno:7133');
    expect(body).toContain('INSFORGE_DEPLOYMENT_METHOD: cli-local');
    expect(body).toContain('ACCESS_API_KEY:');
    // Postgres settings that postgres-all's baked conf had lost.
    expect(body).toContain('insforge_pg_utils');
    expect(body).toContain('insforge.internal_schemas=');
    expect(body).toContain('insforge.policy_grant_role=');
    expect(body).toContain('insforge.extension_grant_role=');
    // Pinned before the first release; changing it later would initdb an empty
    // cluster beside the real one.
    expect(body).toContain('PGDATA: /var/lib/postgresql/data/pgdata');
  });

  it('publishes every port on loopback only', () => {
    const body = readFileSync(composeFiles('local')[0], 'utf-8');
    const published = body.split('\n').filter((l) => /^\s+- "\S+:\d+"$/.test(l.trimEnd()));
    expect(published.length).toBeGreaterThan(0);
    for (const line of published) expect(line).toContain('127.0.0.1:');
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
