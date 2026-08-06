import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetsDir, composeArgs, composeFiles, parsePsJson, writeRenderedCompose } from './compose.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'if-compose-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('assetsDir', () => {
  it('finds the bundled template and the files it inlines', () => {
    const dir = assetsDir();
    for (const f of ['docker-compose.template.yml', 'db-init.sql', 'server.ts', 'worker-template.js']) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
  });
});

describe('writeRenderedCompose', () => {
  it('inlines the three files as compose configs', () => {
    const cwd = tmp();
    const body = readFileSync(writeRenderedCompose(cwd), 'utf-8');
    expect(body).toContain('configs:');
    // PostgREST runs with PGRST_DB_ANON_ROLE=anon and starts before the backend
    // migrates, so these roles have to come from cluster init.
    expect(body).toContain('CREATE ROLE anon');
    expect(body).toContain('CREATE ROLE project_admin');
    // The edge-function runtime host, which reads function code out of Postgres.
    expect(body).toContain('functions.definitions');
    expect(body).not.toContain('__INSFORGE_CONFIGS__');
  });

  it('produces a file docker compose can parse', () => {
    // A YAML syntax error here would only surface as a runtime failure, and the
    // inlined payloads contain quotes, backticks and # characters.
    const cwd = tmp();
    const body = readFileSync(writeRenderedCompose(cwd), 'utf-8');
    for (const key of ['db_init', 'deno_server', 'deno_worker']) {
      expect(body).toMatch(new RegExp(`^  ${key}:$`, 'm'));
    }
    expect(body).toMatch(/^ {4}content: \|$/m);
  });

  it('escapes $ inside the payloads so Compose does not interpolate them', () => {
    // server.ts is TypeScript full of ${...} template literals and db-init.sql
    // uses $$ dollar-quoting. Unescaped, Compose fails the whole project with
    // "invalid interpolation format". Scoped to the configs block: the services
    // below it use ${VAR} interpolation on purpose.
    const cwd = tmp();
    const body = readFileSync(writeRenderedCompose(cwd), 'utf-8');
    const start = body.search(/^configs:$/m);
    const end = body.search(/^services:$/m);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const payload = body.slice(start, end);
    expect(payload).toContain('$$');
    expect(payload.match(/(?<!\$)\$(?!\$)/g)).toBeNull();
  });

  it('bind-mounts nothing from the host', () => {
    // The whole point: no host path is shared with the Docker VM, so Docker
    // Desktop file sharing and SELinux relabelling never come into play.
    const cwd = tmp();
    const body = readFileSync(writeRenderedCompose(cwd), 'utf-8');
    const hostMounts = body
      .split('\n')
      .filter((l) => /^\s+- (\/|\.|\$\{INSFORGE_)/.test(l));
    expect(hostMounts).toEqual([]);
  });
});

describe('composeFiles', () => {
  it('is the rendered file alone for filesystem storage', () => {
    const cwd = tmp();
    const files = composeFiles('local', cwd);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(join(cwd, '.insforge', 'local-compose.yml'));
  });

  it('appends the storage overlay so it wins the merge', () => {
    const cwd = tmp();
    for (const [backend, suffix] of [
      ['minio', 'docker-compose.minio.yml'],
      ['rustfs', 'docker-compose.rustfs.yml'],
    ] as const) {
      const files = composeFiles(backend, cwd);
      expect(files).toHaveLength(2);
      expect(files[1].endsWith(suffix)).toBe(true);
      expect(existsSync(files[1])).toBe(true);
    }
  });
});

describe('template contents', () => {
  const template = (): string =>
    readFileSync(join(assetsDir(), 'docker-compose.template.yml'), 'utf-8');

  it('uses images with CI behind them', () => {
    const images = template().split('\n').filter((l) => l.trim().startsWith('image:')).join('\n');
    expect(images).toContain('ghcr.io/insforge/postgres:v15.13.4');
    expect(images).not.toContain('postgres-all');
    expect(images).toContain('denoland/deno:');
    expect(images).not.toContain('deno-runtime');
  });

  it('carries the settings local instances need', () => {
    const body = template();
    // Edge functions 502 on every invoke without this; upstream omits it.
    expect(body).toContain('DENO_RUNTIME_URL: http://deno:7133');
    expect(body).toContain('INSFORGE_DEPLOYMENT_METHOD: cli-local');
    expect(body).toContain('ACCESS_API_KEY:');
    expect(body).toContain('insforge_pg_utils');
    expect(body).toContain('insforge.policy_grant_role=');
    expect(body).toContain('insforge.extension_grant_role=');
    // Pinned before the first release: changing it later would make Postgres
    // initdb an empty cluster beside the real one and look like a fresh install.
    expect(body).toContain('PGDATA: /var/lib/postgresql/data/pgdata');
  });

  it('publishes every port on loopback only', () => {
    const published = template().split('\n').filter((l) => /^\s+- "\S+:\d+"$/.test(l.trimEnd()));
    expect(published.length).toBeGreaterThan(0);
    for (const line of published) expect(line).toContain('127.0.0.1:');
  });
});

describe('composeArgs', () => {
  it('pins the compose project so instances stay per-directory', () => {
    const cwd = tmp();
    const args = composeArgs({ projectName: 'insforge-app-abc12345', storage: 'local', cwd }, ['up', '-d']);
    expect(args[0]).toBe('compose');
    expect(args[args.indexOf('-p') + 1]).toBe('insforge-app-abc12345');
    expect(args.slice(-2)).toEqual(['up', '-d']);
  });

  it('passes the generated env file', () => {
    const cwd = tmp();
    const args = composeArgs({ projectName: 'p', storage: 'local', cwd }, ['ps']);
    expect(args[args.indexOf('--env-file') + 1]).toBe(join(cwd, '.insforge', 'local.env'));
  });
});

describe('parsePsJson', () => {
  it('reads the line-delimited form', () => {
    const out = parsePsJson(
      '{"Service":"postgres","State":"running","Status":"Up 2m","Health":"healthy"}\n' +
        '{"Service":"insforge","State":"running","Status":"Up 1m","Health":""}\n',
    );
    expect(out.map((s) => s.service)).toEqual(['postgres', 'insforge']);
    expect(out[0].health).toBe('healthy');
  });

  it('reads the single-array form emitted by newer compose', () => {
    expect(parsePsJson('[{"Service":"deno","State":"exited","Status":"Exited (1)"}]')).toEqual([
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
