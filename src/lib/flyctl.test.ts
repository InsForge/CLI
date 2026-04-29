import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { SpawnSyncReturns } from 'node:child_process';

// vi.mock factories are hoisted above ordinary top-level statements, so any
// const they reference must also be hoisted via vi.hoisted (Vitest 4.x docs).
// We mock both spawnSync (used by ensureFlyctlAvailable) and spawn (used by
// flyctlBuildAndPush).
const { spawnSyncMock, spawnMock, existsSyncMock, writeFileSyncMock, unlinkSyncMock } =
  vi.hoisted(() => ({
    spawnSyncMock: vi.fn(),
    spawnMock: vi.fn(),
    existsSyncMock: vi.fn(),
    writeFileSyncMock: vi.fn(),
    unlinkSyncMock: vi.fn(),
  }));
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
  unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
}));

import { CLIError } from './errors.js';
import {
  ensureFlyctlAvailable,
  flyctlBuildAndPush,
} from './flyctl.js';

// ─── spawnSync helpers (mirrors docker.test.ts) ───────────────────────────────

function ok(stdout = ''): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: ['', stdout, ''],
    stdout,
    stderr: '',
    status: 0,
    signal: null,
  };
}

function fail({
  status = 1,
  stderr = '',
  stdout = '',
}: { status?: number; stderr?: string; stdout?: string } = {}): SpawnSyncReturns<string> {
  return { pid: 1, output: ['', stdout, stderr], stdout, stderr, status, signal: null };
}

function notFound(): SpawnSyncReturns<string> {
  const err = Object.assign(new Error('spawn flyctl ENOENT'), { code: 'ENOENT' });
  return {
    pid: 0,
    output: ['', '', ''],
    stdout: '',
    stderr: '',
    status: null,
    signal: null,
    error: err,
  };
}

// ─── spawn (async) helpers ────────────────────────────────────────────────────

interface FakeChild extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/** Drive a fake child through a successful build with the given captured output. */
function driveSuccess(child: FakeChild, output: string) {
  setImmediate(() => {
    child.stdout!.emit('data', Buffer.from(output));
    child.emit('exit', 0);
  });
}

function driveFailure(child: FakeChild, code: number, stderr = '') {
  setImmediate(() => {
    if (stderr) child.stderr!.emit('data', Buffer.from(stderr));
    child.emit('exit', code);
  });
}

function driveSpawnError(child: FakeChild, err: Error) {
  setImmediate(() => {
    child.emit('error', err);
  });
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnMock.mockReset();
  existsSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  unlinkSyncMock.mockReset();
  // Default: assume user already has fly.toml so the stub path is a no-op.
  // Stub-creation is exercised explicitly in dedicated tests.
  existsSyncMock.mockReturnValue(true);
});
afterEach(() => {
  spawnSyncMock.mockReset();
  spawnMock.mockReset();
  existsSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  unlinkSyncMock.mockReset();
});

// ─── ensureFlyctlAvailable ────────────────────────────────────────────────────

describe('ensureFlyctlAvailable', () => {
  it('passes when flyctl version exits 0', () => {
    spawnSyncMock.mockReturnValue(ok('flyctl v0.3.0\n'));
    expect(() => ensureFlyctlAvailable()).not.toThrow();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'flyctl',
      ['version'],
      expect.objectContaining({ encoding: 'utf8' })
    );
  });

  it('throws CLIError mentioning install instructions when flyctl is missing (ENOENT)', () => {
    spawnSyncMock.mockReturnValue(notFound());
    expect(() => ensureFlyctlAvailable()).toThrow(CLIError);
    try {
      ensureFlyctlAvailable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('flyctl is required');
      expect(msg).toContain('curl -L https://fly.io/install.sh');
      expect(msg).toContain('--image');
    }
  });

  it('throws CLIError when flyctl exits non-zero (e.g. broken install)', () => {
    spawnSyncMock.mockReturnValue(fail({ status: 1, stderr: 'unable to load config' }));
    expect(() => ensureFlyctlAvailable()).toThrow(/flyctl is required/);
    expect(() => ensureFlyctlAvailable()).toThrow(/unable to load config/);
  });

  it('truncates very long stderr in the error detail', () => {
    const longStderr = 'broken-install-detail '.repeat(50);
    spawnSyncMock.mockReturnValue(fail({ status: 1, stderr: longStderr }));
    try {
      ensureFlyctlAvailable();
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      // Truncated to ≤200 chars of detail tail per the source.
      expect(msg.length).toBeLessThan(longStderr.length + 200);
    }
  });
});

// ─── flyctlBuildAndPush ───────────────────────────────────────────────────────

describe('flyctlBuildAndPush', () => {
  const baseOpts = {
    dir: '/tmp/app',
    appId: 'my-svc-proj-abc123',
    imageLabel: 'cli-1234',
    token: 'FlyV1 fm2_super-secret-token',
    region: 'iad',
    port: 8080,
  };

  it('passes deploy/build flags and app/label/dir to flyctl', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    driveSuccess(
      child,
      'pushing manifest for registry.fly.io/my-svc-proj-abc123:cli-1234@sha256:' +
        'a'.repeat(64) +
        '\n'
    );

    await flyctlBuildAndPush(baseOpts);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('flyctl');
    expect(args).toEqual([
      'deploy',
      '--remote-only',
      '--build-only',
      '--push',
      '--app',
      'my-svc-proj-abc123',
      '--image-label',
      'cli-1234',
      '--no-cache',
    ]);
    expect((opts as { cwd: string }).cwd).toBe('/tmp/app');
  });

  it('passes the token in env, never in argv (secret-leak invariant)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    driveSuccess(
      child,
      'pushing manifest for registry.fly.io/my-svc-proj-abc123@sha256:' + 'b'.repeat(64) + '\n'
    );

    await flyctlBuildAndPush(baseOpts);

    const [, args, opts] = spawnMock.mock.calls[0];
    // Argv must not contain the token, the FLY_API_TOKEN literal, or any
    // FlyV1 substring — defense in depth against accidental logging in
    // process listings.
    for (const a of args as string[]) {
      expect(a).not.toContain('FlyV1');
      expect(a).not.toContain(baseOpts.token);
    }
    expect((opts as { env: Record<string, string> }).env.FLY_API_TOKEN).toBe(baseOpts.token);
  });

  it('returns digest-pinned imageRef parsed from buildkit "pushing manifest" line', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const digest = 'c'.repeat(64);
    driveSuccess(
      child,
      [
        '#1 [internal] load build definition',
        `pushing manifest for registry.fly.io/my-svc-proj-abc123:cli-1234@sha256:${digest}`,
        'done',
      ].join('\n')
    );

    const result = await flyctlBuildAndPush(baseOpts);
    expect(result.imageRef).toBe(`registry.fly.io/my-svc-proj-abc123@sha256:${digest}`);
  });

  it('captures the digest from stderr too (buildkit interleaves streams)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const digest = 'd'.repeat(64);
    setImmediate(() => {
      child.stderr!.emit(
        'data',
        Buffer.from(`pushing manifest for registry.fly.io/foo@sha256:${digest}\n`)
      );
      child.emit('exit', 0);
    });

    const result = await flyctlBuildAndPush(baseOpts);
    expect(result.imageRef).toBe(`registry.fly.io/${baseOpts.appId}@sha256:${digest}`);
  });

  it('rejects with CLIError when flyctl exits non-zero', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    driveFailure(child, 2, 'permission denied\n');

    const promise = flyctlBuildAndPush(baseOpts);
    await expect(promise).rejects.toThrow(CLIError);
    await expect(promise).rejects.toThrow(/flyctl deploy --build-only failed \(exit 2\)/);
  });

  it('rejects with CLIError when flyctl is missing (spawn error)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    driveSpawnError(child, Object.assign(new Error('spawn flyctl ENOENT'), { code: 'ENOENT' }));

    const promise = flyctlBuildAndPush(baseOpts);
    await expect(promise).rejects.toThrow(/flyctl deploy could not start/);
    await expect(promise).rejects.toThrow(/ENOENT/);
  });

  it('rejects when flyctl succeeds but no "pushing manifest" line is emitted', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    driveSuccess(
      child,
      'image pushed without manifest line — registry stripped output\n'
    );

    await expect(flyctlBuildAndPush(baseOpts)).rejects.toThrow(
      /pushing manifest" line was not found/
    );
  });

  it('tees child stdout/stderr to process streams (live progress visibility)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    setImmediate(() => {
      child.stdout!.emit('data', Buffer.from('build step 1/3\n'));
      child.stderr!.emit('data', Buffer.from('warn: deprecated flag\n'));
      child.stdout!.emit(
        'data',
        Buffer.from('pushing manifest for registry.fly.io/foo@sha256:' + 'e'.repeat(64) + '\n')
      );
      child.emit('exit', 0);
    });

    await flyctlBuildAndPush(baseOpts);

    expect(stdoutSpy).toHaveBeenCalledWith('build step 1/3\n');
    expect(stderrSpy).toHaveBeenCalledWith('warn: deprecated flag\n');

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  // ─── fly.toml stub behavior ──────────────────────────────────────────────
  // flyctl on a freshly-created Fly app with zero machines errors with
  // "could not create a fly.toml from any machines". The CLI writes a stub
  // before invoking flyctl and removes it after. Stub creation is bypassed
  // when the user already provided a fly.toml.

  it('writes a stub fly.toml when none exists, and cleans it up after', async () => {
    existsSyncMock.mockReturnValue(false);
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    driveSuccess(
      child,
      'pushing manifest for registry.fly.io/my-svc-proj-abc123@sha256:' + 'a'.repeat(64) + '\n'
    );

    await flyctlBuildAndPush(baseOpts);

    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    const [path, body] = writeFileSyncMock.mock.calls[0];
    expect(path).toBe('/tmp/app/fly.toml');
    expect(body).toContain('app = "my-svc-proj-abc123"');
    expect(body).toContain('primary_region = "iad"');
    expect(body).toContain('internal_port = 8080');
    expect(unlinkSyncMock).toHaveBeenCalledWith('/tmp/app/fly.toml');
  });

  it('leaves an existing user-owned fly.toml alone (no write, no unlink)', async () => {
    existsSyncMock.mockReturnValue(true);
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    driveSuccess(
      child,
      'pushing manifest for registry.fly.io/my-svc-proj-abc123@sha256:' + 'a'.repeat(64) + '\n'
    );

    await flyctlBuildAndPush(baseOpts);

    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  it('cleans up the stub even when flyctl exits non-zero', async () => {
    existsSyncMock.mockReturnValue(false);
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    driveFailure(child, 1, 'build error');

    await expect(flyctlBuildAndPush(baseOpts)).rejects.toThrow();
    expect(unlinkSyncMock).toHaveBeenCalledWith('/tmp/app/fly.toml');
  });

  it('cleans up the stub even when spawn errors (flyctl missing)', async () => {
    existsSyncMock.mockReturnValue(false);
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    driveSpawnError(child, new Error('ENOENT'));

    await expect(flyctlBuildAndPush(baseOpts)).rejects.toThrow();
    expect(unlinkSyncMock).toHaveBeenCalledWith('/tmp/app/fly.toml');
  });
});

