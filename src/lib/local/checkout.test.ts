import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkoutDir,
  checkoutEnvFile,
  checkoutReady,
  ensureCheckout,
  missingCheckoutFiles,
  readCheckoutEnv,
  upstreamComposeFile,
} from './checkout.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'if-checkout-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Every file a start needs, in the layout setup.sh writes them. */
const CHECKOUT_FILES = [
  'deploy/docker-compose/docker-compose.yml',
  'deploy/docker-init/db/db-init.sql',
  'deploy/docker-init/db/jwt.sql',
  'deploy/docker-init/db/postgresql.conf',
  'functions/server.ts',
  'functions/deno.json',
  'functions/worker-template.js',
  'docker-compose.minio.yml',
  'docker-compose.rustfs.yml',
];

/** What a successful setup.sh run leaves behind. */
function seedCheckout(cwd: string, env = 'ACCESS_API_KEY=ik_seeded\n'): void {
  for (const f of CHECKOUT_FILES) {
    const path = join(checkoutDir(cwd), f);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# seeded\n');
  }
  writeFileSync(checkoutEnvFile(cwd), env);
}

/** A fake setup.sh that writes the same set, so ensureCheckout sees a real run. */
function fakeSetupScript(): string {
  return (
    '#!/bin/sh\n# INSFORGE_NO_GIT\nset -e\ncd "$1"\n' +
    CHECKOUT_FILES.map((f) => `mkdir -p "$(dirname ${f})" && echo seeded > ${f}`).join('\n') +
    '\n[ -f .env ] || echo "ACCESS_API_KEY=ik_generated" > .env\n'
  );
}

describe('paths', () => {
  it('puts the checkout inside .insforge, not beside it', () => {
    const cwd = tmp();
    expect(checkoutDir(cwd).startsWith(join(cwd, '.insforge'))).toBe(true);
  });

  it('points at the compose file where upstream keeps it', () => {
    // The relative mounts inside that file resolve against its own directory, so
    // this layout is the one the upstream compose expects, not a choice.
    const cwd = tmp();
    expect(upstreamComposeFile(cwd).endsWith(join('deploy', 'docker-compose', 'docker-compose.yml'))).toBe(
      true,
    );
  });
});

describe('checkoutReady', () => {
  it('needs every file the compose mounts, not just the compose file', () => {
    const cwd = tmp();
    expect(checkoutReady(cwd)).toBe(false);
    mkdirSync(dirname(upstreamComposeFile(cwd)), { recursive: true });
    writeFileSync(upstreamComposeFile(cwd), 'services: {}\n');
    writeFileSync(checkoutEnvFile(cwd), 'X=1\n');
    // An interrupted fetch leaves exactly this: the compose file and .env, with
    // the init SQL and function host still missing.
    expect(checkoutReady(cwd)).toBe(false);
    expect(missingCheckoutFiles(cwd)).toContain('deploy/docker-init/db/db-init.sql');
    seedCheckout(cwd);
    expect(checkoutReady(cwd)).toBe(true);
    expect(missingCheckoutFiles(cwd)).toEqual([]);
  });

  it('wants the storage overlay only for the backend that uses it', () => {
    const cwd = tmp();
    seedCheckout(cwd);
    rmSync(join(checkoutDir(cwd), 'docker-compose.minio.yml'));
    expect(checkoutReady(cwd)).toBe(true);
    expect(checkoutReady(cwd, 'rustfs')).toBe(true);
    expect(checkoutReady(cwd, 'minio')).toBe(false);
    expect(missingCheckoutFiles(cwd, 'minio')).toEqual(['docker-compose.minio.yml']);
  });
});

describe('readCheckoutEnv', () => {
  it('reads what setup.sh generated', () => {
    const cwd = tmp();
    seedCheckout(cwd, 'JWT_SECRET=abc\nACCESS_API_KEY=ik_1\n# comment\nBAD LINE\n');
    const env = readCheckoutEnv(cwd);
    expect(env.JWT_SECRET).toBe('abc');
    expect(env.ACCESS_API_KEY).toBe('ik_1');
    expect(Object.keys(env)).toHaveLength(2);
  });

  it('is empty rather than throwing when there is no checkout', () => {
    expect(readCheckoutEnv(tmp())).toEqual({});
  });
});

describe('ensureCheckout', () => {
  it('falls back to an existing checkout when the script cannot be fetched', async () => {
    // Offline with a stack already in place is a restart, not a failure.
    const cwd = tmp();
    seedCheckout(cwd);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(ensureCheckout(cwd)).resolves.toBe(checkoutDir(cwd));
  });

  it('fails with the URL when there is nothing to fall back to', async () => {
    const cwd = tmp();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(ensureCheckout(cwd)).rejects.toThrow(/setup\.sh/);
    await expect(ensureCheckout(cwd)).rejects.toThrow(/offline/);
  });

  it('refuses a response that is not the script it expects', async () => {
    // A captive portal or proxy answers 200 with HTML. Running that would do
    // something other than fetch a stack, so it is rejected by content.
    const cwd = tmp();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '<html>login</html>' })),
    );
    await expect(ensureCheckout(cwd)).rejects.toThrow(/INSFORGE_NO_GIT/);
  });

  it('runs the fetched script and reports its failure', async () => {
    const cwd = tmp();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        // Mentions the flag so the content check passes, then fails.
        text: async () => '#!/bin/sh\n# INSFORGE_NO_GIT\necho boom >&2\nexit 3\n',
      })),
    );
    await expect(ensureCheckout(cwd)).rejects.toThrow(/boom/);
  });

  it('runs the script with INSFORGE_NO_GIT so git is never required', async () => {
    const cwd = tmp();
    const marker = join(cwd, 'saw-no-git');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
          text: async () =>
            `#!/bin/sh\n[ -n "$INSFORGE_NO_GIT" ] && echo yes > ${marker}\n` +
            fakeSetupScript(),
      })),
    );
    await ensureCheckout(cwd);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf-8').trim()).toBe('yes');
    expect(checkoutReady(cwd)).toBe(true);
  });
});

describe('secrets are not regenerated over existing data', () => {
  it('refuses when volumes exist but the env file is gone', async () => {
    // setup.sh generates a new Postgres password whenever .env is absent, and
    // that password is only read when a cluster is created — so against volumes
    // that already exist the backend ends up locked out of its own database.
    const cwd = tmp();
    mkdirSync(dirname(upstreamComposeFile(cwd)), { recursive: true });
    writeFileSync(upstreamComposeFile(cwd), 'services: {}\n');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => fakeSetupScript(),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(ensureCheckout(cwd, () => ['proj_postgres-data'])).rejects.toThrow(/volume/);
    await expect(ensureCheckout(cwd, () => ['proj_postgres-data'])).rejects.toThrow(/--delete-data/);
  });

  it('proceeds when there is no data to strand', async () => {
    const cwd = tmp();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
          statusText: 'OK',
          text: async () => fakeSetupScript(),
      })),
    );
    await expect(ensureCheckout(cwd, () => [])).resolves.toBe(checkoutDir(cwd));
  });

  it('does not ask about volumes when the env file is already there', async () => {
    // A normal restart: the secrets exist, so nothing can be stranded.
    const cwd = tmp();
    seedCheckout(cwd);
    const onExisting = vi.fn(() => ['proj_postgres-data']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '#!/bin/sh\n# INSFORGE_NO_GIT\nexit 0\n',
      })),
    );
    await ensureCheckout(cwd, onExisting);
    expect(onExisting).not.toHaveBeenCalled();
  });
});
