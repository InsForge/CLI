import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';

// vi.mock factories are hoisted above ordinary top-level statements, so any
// const they reference must also be hoisted via vi.hoisted (Vitest 4.x docs).
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import { CLIError } from './errors.js';
import {
  dockerBuild,
  dockerLogin,
  dockerPush,
  ensureDockerAvailable,
} from './docker.js';

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
  const err = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
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

beforeEach(() => spawnSyncMock.mockReset());
afterEach(() => spawnSyncMock.mockReset());

describe('ensureDockerAvailable', () => {
  it('passes when docker version exits 0', () => {
    spawnSyncMock.mockReturnValue(ok('25.0.8\n'));
    expect(() => ensureDockerAvailable()).not.toThrow();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'docker',
      ['version', '--format', '{{.Server.Version}}'],
      expect.objectContaining({ encoding: 'utf8' })
    );
  });

  it('throws CLIError mentioning Docker Desktop when docker is missing', () => {
    spawnSyncMock.mockReturnValue(notFound());
    expect(() => ensureDockerAvailable()).toThrow(CLIError);
    try {
      ensureDockerAvailable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('Docker is required');
      expect(msg).toContain('Docker Desktop');
      expect(msg).toContain('--image');
    }
  });

  it('throws CLIError when docker daemon is down (non-zero exit)', () => {
    spawnSyncMock.mockReturnValue(
      fail({ status: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' })
    );
    expect(() => ensureDockerAvailable()).toThrow(/Docker is required/);
    expect(() => ensureDockerAvailable()).toThrow(/Cannot connect to the Docker daemon/);
  });
});

describe('dockerBuild', () => {
  it('passes platform, tag, and dir to docker build', () => {
    spawnSyncMock.mockReturnValue(ok());
    dockerBuild({ dir: '/tmp/app', imageRef: 'registry.fly.io/foo:bar' });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'docker',
      ['build', '--platform', 'linux/amd64', '-t', 'registry.fly.io/foo:bar', '/tmp/app'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('honours custom platform', () => {
    spawnSyncMock.mockReturnValue(ok());
    dockerBuild({ dir: '.', imageRef: 'r/i:t', platform: 'linux/arm64' });
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    expect(args).toContain('linux/arm64');
  });

  it('throws when docker exits non-zero', () => {
    spawnSyncMock.mockReturnValue(fail({ status: 2 }));
    expect(() => dockerBuild({ dir: '.', imageRef: 'r/i:t' })).toThrow(/docker build failed \(exit 2\)/);
  });

  it('throws a "could not start" error when spawn itself fails', () => {
    spawnSyncMock.mockReturnValue(notFound());
    expect(() => dockerBuild({ dir: '.', imageRef: 'r/i:t' })).toThrow(
      /docker build could not start.*ENOENT/
    );
  });
});

describe('dockerLogin', () => {
  it('pipes the password via stdin and never includes it in argv', () => {
    spawnSyncMock.mockReturnValue(ok());
    dockerLogin('registry.fly.io', 'super-secret-token');
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0];
    expect(cmd).toBe('docker');
    expect(args).toEqual(['login', 'registry.fly.io', '-u', 'x', '--password-stdin']);
    expect(args).not.toContain('super-secret-token');
    expect(opts).toMatchObject({ input: 'super-secret-token' });
  });

  it('throws and includes stderr on auth failure (truncated)', () => {
    const longStderr = 'unauthorized: incorrect username or password '.repeat(20);
    spawnSyncMock.mockReturnValue(fail({ status: 1, stderr: longStderr }));
    try {
      dockerLogin('registry.fly.io', 'x');
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('docker login registry.fly.io failed');
      expect(msg).toContain('unauthorized');
      // Truncated to ≤300 chars of detail tail
      expect(msg.length).toBeLessThan(longStderr.length);
    }
  });

  it('falls back to stdout when stderr is empty', () => {
    spawnSyncMock.mockReturnValue(fail({ status: 1, stdout: 'unable to reach registry' }));
    expect(() => dockerLogin('r', 'x')).toThrow(/unable to reach registry/);
  });

  it('throws "could not start" when docker binary is missing', () => {
    spawnSyncMock.mockReturnValue(notFound());
    expect(() => dockerLogin('r', 'x')).toThrow(/docker login could not start.*ENOENT/);
  });
});

describe('dockerPush', () => {
  it('runs docker push with the image ref', () => {
    spawnSyncMock.mockReturnValue(ok());
    dockerPush('registry.fly.io/foo:bar');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'docker',
      ['push', 'registry.fly.io/foo:bar'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('throws on non-zero exit', () => {
    spawnSyncMock.mockReturnValue(fail({ status: 1 }));
    expect(() => dockerPush('r/i:t')).toThrow(/docker push r\/i:t failed \(exit 1\)/);
  });

  it('throws "could not start" when spawn fails', () => {
    spawnSyncMock.mockReturnValue(notFound());
    expect(() => dockerPush('r/i:t')).toThrow(/docker push could not start.*ENOENT/);
  });
});
