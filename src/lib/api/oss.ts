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

export async function getJwtSecret(): Promise<string | null> {
  // Returns null if the project doesn't expose JWT_SECRET — caller falls back
  // to leaving the env var as-is so the user can fill it manually.
  try {
    const res = await ossFetch('/api/secrets/JWT_SECRET');
    const data = await res.json() as { value?: string };
    return typeof data.value === 'string' && data.value.length > 0 ? data.value : null;
  } catch {
    return null;
  }
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
    const err = await res.json().catch(() => ({})) as {
      error?: string;
      message?: string;
      nextActions?: string;
      statusCode?: number;
    };

    let message = err.message ?? err.error ?? `OSS request failed: ${res.status}`;
    if (err.nextActions) {
      message += `\n${err.nextActions}`;
    }

    // Feature not available on this backend version — ONLY when the 404 is a
    // route-level miss (no structured error code), not a resource-level miss
    // like COMPUTE_SERVICE_NOT_FOUND. Otherwise we'd hide real "service doesn't
    // exist" errors behind a misleading "feature not enabled" message.
    const isRouteLevel404 = !err.error || err.error === 'NOT_FOUND';
    if (res.status === 404 && isRouteLevel404 && path.startsWith('/api/compute')) {
      message = 'Compute services are not available on this backend.\nSelf-hosted: upgrade your InsForge instance. Cloud: contact your InsForge admin to enable compute.';
    }

    if (res.status === 404 && isRouteLevel404 && path.startsWith('/api/payments')) {
      message = 'Payments are not available on this backend.\nSelf-hosted: upgrade your InsForge instance. Cloud/private preview: contact your InsForge admin to enable payments.';
    }

    if (res.status === 404 && isRouteLevel404 && path === '/api/database/migrations') {
      message = 'Database migrations are not available on this backend.\nSelf-hosted: upgrade your InsForge instance. Cloud: contact your InsForge admin about database migration support.';
    }

    throw new CLIError(message);
  }

  return res;
}
