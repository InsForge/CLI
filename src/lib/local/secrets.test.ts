import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateSecrets,
  parseEnvFile,
  readSecrets,
  renderEnvFile,
  writeEnvFile,
  type LocalSecrets,
} from './secrets.js';
import type { LocalPorts } from './state.js';

const dirs: string[] = [];
function tmp(): string {
  // Deliberately NOT creating .insforge/ — writeEnvFile must create it itself.
  const d = mkdtempSync(join(tmpdir(), 'if-secrets-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const PORTS: LocalPorts = { app: 7130, auth: 7131, deno: 7133, postgres: 5432, postgrest: 5430 };

describe('generateSecrets', () => {
  it('prefixes the keys the way the backend expects', () => {
    const s = generateSecrets();
    expect(s.apiKey).toMatch(/^ik_[0-9a-f]{40}$/);
    expect(s.anonKey).toMatch(/^anon_[0-9a-f]{40}$/);
  });

  it('clears the backend 32-character minimum for JWT_SECRET', () => {
    expect(generateSecrets().jwtSecret.length).toBeGreaterThanOrEqual(32);
  });

  it('does not reuse values between runs', () => {
    expect(generateSecrets().apiKey).not.toBe(generateSecrets().apiKey);
  });
});

describe('renderEnvFile', () => {
  const secrets = generateSecrets();

  it('emits the keys the compose file reads', () => {
    const env = parseEnvFile(
      renderEnvFile({ secrets, ports: PORTS, storage: 'local', stackTag: null }),
    );
    expect(env.ACCESS_API_KEY).toBe(secrets.apiKey);
    expect(env.ACCESS_ANON_KEY).toBe(secrets.anonKey);
    expect(env.APP_PORT).toBe('7130');
    expect(env.INSFORGE_DEPLOYMENT_METHOD).toBe('cli-local');
    expect(env.API_BASE_URL).toBe('http://localhost:7130');
  });

  it('omits INSFORGE_STACK_TAG when nothing was resolved', () => {
    const env = parseEnvFile(
      renderEnvFile({ secrets, ports: PORTS, storage: 'local', stackTag: null }),
    );
    expect(env.INSFORGE_STACK_TAG).toBeUndefined();
  });

  it('sets the store credentials the chosen overlay reads', () => {
    const minio = parseEnvFile(
      renderEnvFile({ secrets, ports: PORTS, storage: 'minio', stackTag: 'v2.2.9' }),
    );
    expect(minio.MINIO_ROOT_USER).toBe(secrets.storeAccessKey);
    expect(minio.MINIO_ROOT_PASSWORD).toBe(secrets.storeSecretKey);
    expect(minio.RUSTFS_ACCESS_KEY).toBeUndefined();

    const rustfs = parseEnvFile(
      renderEnvFile({ secrets, ports: PORTS, storage: 'rustfs', stackTag: 'v2.2.9' }),
    );
    expect(rustfs.RUSTFS_ACCESS_KEY).toBe(secrets.storeAccessKey);
    expect(rustfs.MINIO_ROOT_USER).toBeUndefined();
  });

  it('does not use the overlays’ documented default store password', () => {
    const env = parseEnvFile(
      renderEnvFile({ secrets, ports: PORTS, storage: 'minio', stackTag: null }),
    );
    expect(env.MINIO_ROOT_PASSWORD).not.toBe('insforge-minio-secret');
  });
});

describe('writeEnvFile / readSecrets', () => {
  // A failed read-back is not a cosmetic problem: start would regenerate every
  // secret and rotate the API key away from the .env.local the app already has.
  it.each(['local', 'minio', 'rustfs'] as const)('round-trips every field (%s storage)', (storage) => {
    const cwd = tmp();
    const secrets = generateSecrets();
    writeEnvFile({ secrets, ports: PORTS, storage, stackTag: 'v2.2.9' }, cwd);
    expect(readSecrets(cwd)).toEqual<LocalSecrets>(secrets);
  });

  it('writes the file 0600 — it holds the superadmin key', () => {
    const cwd = tmp();
    writeEnvFile({ secrets: generateSecrets(), ports: PORTS, storage: 'local', stackTag: null }, cwd);
    const mode = statSync(join(cwd, '.insforge', 'local.env')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns null when the file is missing', () => {
    expect(readSecrets(tmp())).toBeNull();
  });

  it('creates .insforge/ and its .gitignore itself', () => {
    const cwd = tmp();
    writeEnvFile({ secrets: generateSecrets(), ports: PORTS, storage: 'local', stackTag: null }, cwd);
    expect(existsSync(join(cwd, '.insforge', 'local.env'))).toBe(true);
    expect(readFileSync(join(cwd, '.insforge', '.gitignore'), 'utf-8')).toContain('local.env');
  });

  it('returns null on a truncated file instead of half-configuring compose', () => {
    const cwd = tmp();
    const secrets = generateSecrets();
    writeEnvFile({ secrets, ports: PORTS, storage: 'local', stackTag: null }, cwd);
    // Drop ACCESS_API_KEY, simulating a partial write.
    const body = readFileSync(join(cwd, '.insforge', 'local.env'), 'utf-8')
      .split('\n')
      .filter((l) => !l.startsWith('ACCESS_API_KEY='))
      .join('\n');
    writeFileSync(join(cwd, '.insforge', 'local.env'), body);
    expect(readSecrets(cwd)).toBeNull();
  });
});

describe('parseEnvFile', () => {
  it('skips comments and blank lines, and keeps values containing =', () => {
    const env = parseEnvFile('# c\n\nA=1\nB=x=y\nnot-an-assignment\n');
    expect(env).toEqual({ A: '1', B: 'x=y' });
  });
});
