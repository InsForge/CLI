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
  it('always applies the local overlay', () => {
    const files = composeFiles('local');
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/docker-compose\.yml$/);
    expect(files[1]).toMatch(/docker-compose\.local\.yml$/);
    expect(existsSync(files[1])).toBe(true);
  });

  it('puts the storage overlay last so it wins the merge', () => {
    for (const [backend, suffix] of [
      ['minio', 'docker-compose.minio.yml'],
      ['rustfs', 'docker-compose.rustfs.yml'],
    ] as const) {
      const files = composeFiles(backend);
      expect(files).toHaveLength(3);
      expect(files[0]).toMatch(/docker-compose\.yml$/);
      expect(files[1]).toMatch(/docker-compose\.local\.yml$/);
      expect(files[2].endsWith(suffix)).toBe(true);
      expect(existsSync(files[2])).toBe(true);
    }
  });

  it('the local overlay uses the CI-built base postgres image, not postgres-all', () => {
    const overlay = readFileSync(composeFiles('local')[1], 'utf-8');
    // Assert on the image line specifically — the file's comments discuss
    // postgres-all, so a whole-file substring check would be meaningless.
    const imageLine = overlay.split('\n').find((l) => l.trim().startsWith('image:')) ?? '';
    expect(imageLine).toContain('ghcr.io/insforge/postgres:v15.13.4');
    expect(imageLine).not.toContain('postgres-all');
    // Seeding the keys and the telemetry channel are local-only concerns, so they
    // live here rather than as variables in the upstream compose file.
    expect(overlay).toContain('ACCESS_API_KEY:');
    expect(overlay).toContain('INSFORGE_DEPLOYMENT_METHOD: cli-local');
    // The settings postgres-all's hand-built conf had lost.
    expect(overlay).toContain('insforge_pg_utils');
    expect(overlay).toContain('insforge.internal_schemas=');
    expect(overlay).toContain('insforge.policy_grant_role=');
    expect(overlay).toContain('insforge.policy_grant_tables=');
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
