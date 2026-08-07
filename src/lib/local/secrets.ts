/**
 * The env file the local stack runs on.
 *
 * InsForge's setup.sh generates the secrets — JWT, encryption key, Postgres and
 * admin passwords, and the two access keys — into `.insforge/checkout/.env`, and
 * leaves that file alone on re-runs. The CLI reads them back for wiring and adds
 * what only it knows: the ports this directory chose, and the store credentials
 * a storage overlay needs.
 *
 * Generating them here as well would be a second implementation of something the
 * script already does fail-closed, and would make the two disagree about what an
 * instance's keys are.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CLIError } from '../errors.js';
import { checkoutEnvFile } from './checkout.js';
import type { LocalPorts, StorageBackend } from './state.js';

/** What the CLI needs to know about a running instance to wire a directory to it. */
export interface LocalSecrets {
  apiKey: string;
  anonKey: string;
  adminUsername: string;
  adminPassword: string;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Set variables in the checkout's env file, leaving everything else in place.
 *
 * The same shape as setup.sh's own set_var: replace a key that is there, append
 * one that is not. That is what lets the script and the CLI write to one file
 * without either clobbering the other's values.
 */
export function setEnvVars(vars: Record<string, string>, cwd?: string): void {
  const path = checkoutEnvFile(cwd);
  if (!existsSync(path)) {
    throw new CLIError(`${path} is missing. Run \`insforge local start\` to create it.`);
  }
  const lines = readFileSync(path, 'utf-8').split('\n');
  for (const [key, value] of Object.entries(vars)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i === -1) lines.push(`${key}=${value}`);
    else lines[i] = `${key}=${value}`;
  }
  writeFileSync(path, lines.join('\n'), { mode: 0o600 });
}

/** Read what setup.sh generated. Null when a value it should have written is absent. */
export function readSecrets(cwd?: string): LocalSecrets | null {
  const path = checkoutEnvFile(cwd);
  if (!existsSync(path)) return null;
  const env = parseEnvFile(readFileSync(path, 'utf-8'));
  const apiKey = env.ACCESS_API_KEY;
  const anonKey = env.ACCESS_ANON_KEY;
  const adminUsername = env.ROOT_ADMIN_USERNAME;
  const adminPassword = env.ROOT_ADMIN_PASSWORD;
  if (!apiKey || !anonKey || !adminUsername || !adminPassword) return null;
  return { apiKey, anonKey, adminUsername, adminPassword };
}

export interface EnvDeltaInput {
  ports: LocalPorts;
  storage: StorageBackend;
  cwd?: string;
}

/**
 * Write the values setup.sh does not know about.
 *
 * Store credentials are generated once and then read back, so a restart does not
 * rotate them out from under a MinIO volume that already has data under the old
 * ones.
 */
export function writeEnvDeltas({ ports, storage, cwd }: EnvDeltaInput): void {
  const existing = parseEnvFile(readFileSync(checkoutEnvFile(cwd), 'utf-8'));
  const vars: Record<string, string> = {
    POSTGRES_PORT: String(ports.postgres),
    POSTGREST_PORT: String(ports.postgrest),
    APP_PORT: String(ports.app),
    AUTH_PORT: String(ports.auth),
    DENO_PORT: String(ports.deno),
    API_BASE_URL: `http://localhost:${ports.app}`,
    VITE_API_BASE_URL: `http://localhost:${ports.app}`,
  };

  if (storage === 'minio' || storage === 'rustfs') {
    const user = storage === 'minio' ? 'MINIO_ROOT_USER' : 'RUSTFS_ACCESS_KEY';
    const pass = storage === 'minio' ? 'MINIO_ROOT_PASSWORD' : 'RUSTFS_SECRET_KEY';
    vars[user] = existing[user] || 'insforge';
    vars[pass] = existing[pass] || hex(16);
  }

  setEnvVars(vars, cwd);
}
