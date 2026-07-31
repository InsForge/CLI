import { getPlatformApiUrl } from '../config.js';
import { CLIError, formatFetchError } from '../errors.js';
import { ossFetch } from './oss.js';

const REQUEST_TIMEOUT_MS = 30_000;

// Wraps fetch with a per-request 30s timeout. If `callerSignal` aborts, the
// fetch aborts too. Always clears the timeout on completion.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  callerSignal?: AbortSignal,
): Promise<Response> {
  if (callerSignal?.aborted) {
    throw new CLIError('Connection wait cancelled.');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
  const onCallerAbort = (): void => ac.abort();
  callerSignal?.addEventListener('abort', onCallerAbort);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

// Shape of GET /integrations/apify/v1/connection (cloud-backend
// getConnectionByQuery). Apify has no separate project/api key like PostHog's
// phc_ — only the OAuth token, held server-side — so this is metadata only.
export interface ApifyConnectionResponse {
  apifyUsername?: string | null;
  plan?: string | null;
  status?: string;
  createdAt?: string;
}

export type ConnectionFetch =
  | { kind: 'connected'; connection: ApifyConnectionResponse }
  | { kind: 'not-connected' }
  | { kind: 'forbidden'; message: string }
  | { kind: 'unauthorized'; message: string }
  | { kind: 'error'; message: string; status?: number };

/**
 * GET /integrations/apify/v1/connection?project_id=<id>
 *
 * Endpoint is owned by cloud-backend. Uses user-level Bearer auth from
 * `insforge login` rather than the project JWT — cloud-backend enforces a
 * membership check on the project.
 *
 * Coded defensively: a 200 with a `status` field means connected.
 *
 * Returns a tagged union rather than throwing on the common 404 case so the
 * caller can decide between "trigger browser flow" and "real error".
 */
export async function fetchApifyConnection(
  projectId: string,
  jwt: string,
  apiUrl?: string,
  signal?: AbortSignal,
): Promise<ConnectionFetch> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const url = `${baseUrl}/integrations/apify/v1/connection?project_id=${encodeURIComponent(projectId)}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/json',
        },
      },
      signal,
    );
  } catch (err) {
    return { kind: 'error', message: formatFetchError(err, url) };
  }

  if (res.status === 404) {
    return { kind: 'not-connected' };
  }

  if (res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      kind: 'forbidden',
      message: body.error ?? 'Forbidden — you may not have access to this project.',
    };
  }

  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      kind: 'unauthorized',
      message: body.error ?? 'Not authenticated.',
    };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      kind: 'error',
      message: body.error ?? `Request failed: HTTP ${res.status}`,
      status: res.status,
    };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    return {
      kind: 'error',
      message: `Could not parse connection response: ${(err as Error).message}`,
    };
  }

  // 404 (handled above) is the not-connected signal. A 200 means cloud-backend
  // has a connection row; it always carries `status`. Require that field so a
  // stray empty body keeps us polling instead of declaring success early.
  const conn = (data ?? {}) as ApifyConnectionResponse;
  if (!conn.status) {
    return { kind: 'not-connected' };
  }

  // A freshly-authorized connection is 'active'. 'revoked' means the refresh
  // token died — treat as not-connected so the user re-authorizes.
  if (conn.status === 'revoked') {
    return { kind: 'not-connected' };
  }

  return { kind: 'connected', connection: conn };
}

export interface ApifyTokenStatus {
  configured: boolean;
  maskedKey: string | null;
}

/**
 * Store a developer-supplied Apify API token on a self-hosted InsForge backend.
 *
 * Calls PUT /api/webscraper/apify/config on the project's OSS host. The backend
 * validates the token against Apify before saving, so a 400 here means the token
 * is bad — or that this is a cloud project, where the connection is made by OAuth
 * instead. Both arrive as a CLIError from ossFetch carrying the backend's message,
 * so they are left to propagate unchanged.
 *
 * A 2xx response is not itself proof the token was stored: an empty/non-JSON
 * body is treated the same as a missing `token` object (APIFY_CONFIG_MALFORMED
 * — the endpoint's response shape can't be trusted), while a well-formed body
 * with `configured: false` is a distinct condition — the write may have
 * succeeded but the read-back didn't find the secret — surfaced under its own
 * APIFY_TOKEN_NOT_STORED code so callers can tell "can't parse the response"
 * apart from "parsed fine, but nothing was actually stored".
 */
export async function storeApifyToken(apiToken: string): Promise<ApifyTokenStatus> {
  const res = await ossFetch('/api/webscraper/apify/config', {
    method: 'PUT',
    body: JSON.stringify({ apiToken }),
  });

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (typeof data !== 'object' || data === null) {
    throw new CLIError(
      'Apify config endpoint returned no token status; try again.',
      1,
      'APIFY_CONFIG_MALFORMED',
    );
  }

  const token = (data as { token?: ApifyTokenStatus }).token;
  if (!token) {
    throw new CLIError(
      'Apify config endpoint returned no token status; try again.',
      1,
      'APIFY_CONFIG_MALFORMED',
    );
  }

  if (token.configured !== true) {
    throw new CLIError(
      'Apify did not report the token as stored; try again.',
      1,
      'APIFY_TOKEN_NOT_STORED',
    );
  }

  return token;
}

export interface PollOptions {
  /** Total deadline before giving up. */
  timeoutMs: number;
  /** Steady-state interval between polls. */
  intervalMs: number;
  /** Max retries on transient (network/5xx) errors before giving up early. */
  maxTransientRetries: number;
  /** Optional callback invoked once per attempt — used for spinner updates. */
  onTick?: (elapsedMs: number) => void;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

/**
 * Poll the connection endpoint until it returns a connected response, the
 * deadline elapses, or the user aborts. 401 and 403 short-circuit (retrying
 * won't flip an auth/permission failure); other transient errors (network,
 * 5xx) are tolerated up to `maxTransientRetries` consecutive failures.
 */
export async function pollApifyConnection(
  projectId: string,
  jwt: string,
  opts: PollOptions,
  apiUrl?: string,
): Promise<ApifyConnectionResponse> {
  const start = Date.now();
  let consecutiveErrors = 0;

  for (;;) {
    if (opts.signal?.aborted) {
      throw new CLIError('Connection wait cancelled.');
    }

    const elapsed = Date.now() - start;
    if (elapsed >= opts.timeoutMs) {
      throw new CLIError(
        'Timed out waiting for Apify connection. Re-run `insforge webscraper apify connect` after authorizing.',
      );
    }
    opts.onTick?.(elapsed);

    const result = await fetchApifyConnection(projectId, jwt, apiUrl, opts.signal);

    switch (result.kind) {
      case 'connected':
        return result.connection;
      case 'forbidden':
        throw new CLIError(`Forbidden: ${result.message}`, 5);
      case 'unauthorized':
        throw new CLIError(
          `Not authenticated (HTTP 401): ${result.message}. Re-run \`insforge login\`.`,
          2,
        );
      case 'error':
        consecutiveErrors += 1;
        if (consecutiveErrors >= opts.maxTransientRetries) {
          throw new CLIError(
            `Connection check failed after ${opts.maxTransientRetries} retries: ${result.message}`,
          );
        }
        break;
      case 'not-connected':
        consecutiveErrors = 0;
        break;
    }

    await sleep(opts.intervalMs, opts.signal);
  }
}

export type ApifyCliStartResponse =
  | { type: 'connected' }
  | { type: 'authorize'; authorizeUrl: string };

/**
 * GET /integrations/apify/v1/cli-start?p=<projectId>
 *
 * Asks cloud-backend whether this project is already connected (or can be
 * inline auto-provisioned for new users) — in which case we skip the browser
 * hop entirely. Otherwise returns a direct Apify `authorizeUrl` that the user
 * must consent at; the URL points straight at apify.com (no Insforge
 * dashboard in the path).
 */
export async function startApifyCliFlow(
  projectId: string,
  jwt: string,
  apiUrl?: string,
): Promise<ApifyCliStartResponse> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const url = `${baseUrl}/integrations/apify/v1/cli-start?p=${encodeURIComponent(projectId)}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    throw new CLIError(`Failed to start Apify connect flow: ${formatFetchError(err, url)}`);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const msg = body.error ?? res.statusText ?? `HTTP ${res.status}`;
    if (res.status === 401) {
      throw new CLIError(`Not authenticated (HTTP 401): ${msg}. Re-run \`insforge login\`.`);
    }
    if (res.status === 403) {
      throw new CLIError(`Forbidden (HTTP 403): ${msg}`, 5);
    }
    if (res.status === 404) {
      throw new CLIError(
        `Apify connect flow unavailable (HTTP 404): ${msg}. Check that the project is linked.`,
      );
    }
    throw new CLIError(`Apify cli-start failed (HTTP ${res.status}): ${msg}`);
  }

  const data = (await res.json().catch(() => ({}))) as Partial<ApifyCliStartResponse> & {
    authorizeUrl?: string;
  };

  if (data.type === 'connected') {
    return { type: 'connected' };
  }
  if (data.type === 'authorize' && typeof data.authorizeUrl === 'string' && data.authorizeUrl) {
    return { type: 'authorize', authorizeUrl: data.authorizeUrl };
  }
  throw new CLIError('Apify cli-start returned an unexpected response shape.');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CLIError('Connection wait cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CLIError('Connection wait cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
