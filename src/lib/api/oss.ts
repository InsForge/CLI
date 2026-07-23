import { getProjectConfig } from '../config.js';
import { CLIError, formatFetchError, ProjectNotLinkedError } from '../errors.js';
import type {
  ProjectConfig,
  RotateKeyResponse,
  S3AccessKey,
  S3AccessKeyWithSecret,
} from '../../types.js';

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

// Splice the real password into a masked Postgres URL like
// `postgresql://postgres:********@host:5432/db?sslmode=require`. Replaces
// the segment between the first `://<user>:` and the next `@`. Exported
// for unit testing.
export function spliceDatabasePassword(maskedUrl: string, password: string): string {
  return maskedUrl.replace(/^(postgresql:\/\/[^:]+:)[^@]+(@)/, `$1${password}$2`);
}

// The platform also returns the password as `********` (or any run of `*`)
// while the project is finishing provisioning — splicing that into the URL
// is a silent no-op and leaves the user with an unusable masked URL in
// `.env.local`. Treat it the same as "not ready".
export function isMaskedDatabasePassword(value: string): boolean {
  return /^\*+$/.test(value);
}

async function fetchDatabasePasswordOnce(): Promise<string | null> {
  try {
    const res = await ossFetch('/api/metadata/database-password');
    const body = await res.json() as { databasePassword?: string };
    const pw = body.databasePassword;
    if (typeof pw !== 'string' || !pw || isMaskedDatabasePassword(pw)) return null;
    return pw;
  } catch {
    return null;
  }
}

export async function getDatabaseConnectionString(): Promise<string | null> {
  // Cloud-only: returns the project's Postgres URL with the real password
  // substituted in. The platform's `/database-connection-string` endpoint
  // masks the password (`postgresql://postgres:********@...`); we hit
  // `/database-password` separately to splice the real password in.
  //
  // Right after `create`, the project flips to `status=active` before the
  // password generator has populated `/database-password` — that endpoint
  // can return `********` itself for ~5-10s. So we poll briefly (up to 20s
  // total) until we see a real password before giving up. Self-hosted /
  // older projects without the endpoint return null and we fall back.
  try {
    const urlRes = await ossFetch('/api/metadata/database-connection-string');
    const urlBody = await urlRes.json() as { connectionURL?: string };
    const masked = urlBody.connectionURL;
    if (typeof masked !== 'string' || !masked) return null;

    let password = await fetchDatabasePasswordOnce();
    const POLL_ATTEMPTS = 9;
    const POLL_DELAY_MS = 2_000;
    for (let attempt = 0; password === null && attempt < POLL_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_DELAY_MS));
      password = await fetchDatabasePasswordOnce();
    }
    if (password === null) return null;

    return spliceDatabasePassword(masked, password);
  } catch {
    return null;
  }
}

// --- Secrets rotation ---

/**
 * Rotate the project API key or anon key. The old key keeps working for
 * `gracePeriodHours` (server default applies when omitted) so deployed
 * clients don't break instantly. The new plaintext key is returned once.
 */
export async function rotateApiKey(gracePeriodHours?: number): Promise<RotateKeyResponse> {
  const res = await ossFetch('/api/secrets/api-key/rotate', {
    method: 'POST',
    body: JSON.stringify(gracePeriodHours === undefined ? {} : { gracePeriodHours }),
  });
  return await res.json() as RotateKeyResponse;
}

export async function rotateAnonKey(gracePeriodHours?: number): Promise<RotateKeyResponse> {
  const res = await ossFetch('/api/secrets/anon-key/rotate', {
    method: 'POST',
    body: JSON.stringify(gracePeriodHours === undefined ? {} : { gracePeriodHours }),
  });
  return await res.json() as RotateKeyResponse;
}

// --- S3 access keys ---

export async function listS3AccessKeys(): Promise<S3AccessKey[]> {
  const res = await ossFetch('/api/storage/s3/access-keys');
  return await res.json() as S3AccessKey[];
}

export async function createS3AccessKey(description?: string): Promise<S3AccessKeyWithSecret> {
  const res = await ossFetch('/api/storage/s3/access-keys', {
    method: 'POST',
    body: JSON.stringify(description ? { description } : {}),
  });
  return await res.json() as S3AccessKeyWithSecret;
}

export async function deleteS3AccessKey(id: string): Promise<void> {
  await ossFetch(`/api/storage/s3/access-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

    if (res.status === 404 && isRouteLevel404 && path.startsWith('/api/ai')) {
      message = 'AI Model Gateway setup is not available on this backend.\nUpgrade your InsForge project to a version with Model Gateway support, or keep using the legacy @insforge/sdk AI modules for projects that still rely on the older AI API surface.';
    }

    if (res.status === 404 && isRouteLevel404 && path.startsWith('/api/memory')) {
      message = 'Agent memory is not available on this backend.\nSelf-hosted: upgrade your InsForge instance to a version with the memory feature. Cloud: contact your InsForge admin to enable agent memory.';
    }

    if (res.status === 404 && isRouteLevel404 && path.startsWith('/api/webscraper')) {
      message = 'The web scraper is not available on this backend.\nThe Apify web scraper is cloud-only. Self-hosted: this feature is not supported. Cloud: contact your InsForge admin to enable it.';
    }

    // Safe to treat any 404 on /api/advisor/* as a route-level miss: the OSS
    // advisor endpoints return 200 with a null/empty body when no scan exists
    // (a resource-level "no data" state), so they never emit a 404 for a
    // present-but-empty resource. A 404 here therefore means the route itself
    // is absent (backend older than the advisor feature).
    if (res.status === 404 && isRouteLevel404 && path.startsWith('/api/advisor')) {
      message = 'Backend Advisor is not available on this backend.\nSelf-hosted: upgrade your InsForge instance. Cloud: update the project to a newer version.';
    }

    throw new CLIError(message, 1, err.error, res.status);
  }

  return res;
}

/**
 * Probe an InsForge backend's `/api/health` on an EXPLICIT base URL.
 *
 * Unlike `ossFetch`, this deliberately does not read the linked project: a
 * freshly created branch is not linked yet, and the whole point is to ask
 * whether ITS host is answering before we tell the user it is usable.
 *
 * Unauthenticated and non-throwing — callers poll it, so a connection reset
 * while the instance boots is an expected answer ("not yet"), not an error.
 */
export async function probeBackendHealth(
  baseUrl: string,
  timeoutMs = 10_000,
): Promise<{ reachable: boolean; status: number | null; detail?: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: res.ok, status: res.status };
  } catch (err) {
    return { reachable: false, status: null, detail: formatFetchError(err, url) };
  }
}
