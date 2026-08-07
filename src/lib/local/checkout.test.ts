import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkoutDir,
  checkoutEnvFile,
  checkoutReady,
  ensureCheckout,
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

/** What a successful setup.sh run leaves behind. */
function seedCheckout(cwd: string, env = 'ACCESS_API_KEY=ik_seeded\n'): void {
  const compose = upstreamComposeFile(cwd);
  mkdirSync(dirname(compose), { recursive: true });
  writeFileSync(compose, 'services: {}\n');
  writeFileSync(checkoutEnvFile(cwd), env);
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
  it('needs both the compose file and the env file', () => {
    const cwd = tmp();
    expect(checkoutReady(cwd)).toBe(false);
    mkdirSync(dirname(upstreamComposeFile(cwd)), { recursive: true });
    writeFileSync(upstreamComposeFile(cwd), 'services: {}\n');
    expect(checkoutReady(cwd)).toBe(false);
    writeFileSync(checkoutEnvFile(cwd), 'X=1\n');
    expect(checkoutReady(cwd)).toBe(true);
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
          '#!/bin/sh\n# INSFORGE_NO_GIT\n' +
          `[ -n "$INSFORGE_NO_GIT" ] && echo yes > ${marker}\n` +
          'mkdir -p "$1/deploy/docker-compose"\n' +
          'echo "services: {}" > "$1/deploy/docker-compose/docker-compose.yml"\n' +
          'echo "ACCESS_API_KEY=ik_x" > "$1/.env"\n',
      })),
    );
    await ensureCheckout(cwd);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf-8').trim()).toBe('yes');
    expect(checkoutReady(cwd)).toBe(true);
  });
});
