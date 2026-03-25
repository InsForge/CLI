import { getProjectConfig } from '../config.js';
import { CLIError, ProjectNotLinkedError } from '../errors.js';
import type { ProjectConfig } from '../../types.js';

function requireProjectConfig(): ProjectConfig {
  const config = getProjectConfig();
  if (!config) {
    throw new ProjectNotLinkedError();
  }
  return config;
}

/**
 * Unified OSS API fetch. Uses API key as Bearer token for all requests,
 * which grants superadmin access (SQL execution, bucket management, etc.).
 */
export interface RawSqlResult {
  rows: Record<string, unknown>[];
  raw: Record<string, unknown>;
}

export async function runRawSql(sql: string, unrestricted = false): Promise<RawSqlResult> {
  const endpoint = unrestricted
    ? '/api/database/advance/rawsql/unrestricted'
    : '/api/database/advance/rawsql';
  const res = await ossFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({ query: sql }),
  });
  const raw = await res.json() as Record<string, unknown>;
  const rows = (raw.rows ?? raw.data ?? []) as Record<string, unknown>[];
  return { rows, raw };
}

export async function getAnonKey(): Promise<string> {
  const res = await ossFetch('/api/auth/tokens/anon', { method: 'POST' });
  const data = await res.json() as { accessToken: string };
  return data.accessToken;
}

export async function ossFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const config = requireProjectConfig();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.api_key}`,
    ...(options.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(`${config.oss_host}${path}`, { ...options, headers });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new CLIError(err.error ?? `OSS request failed: ${res.status}`);
  }

  return res;
}
