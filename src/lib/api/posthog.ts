import { getPlatformApiUrl } from '../config.js';
import { CLIError, formatFetchError } from '../errors.js';

const REQUEST_TIMEOUT_MS = 30_000;

// Wraps fetch with a per-request 30s timeout. If `callerSignal` aborts, the
// fetch aborts too. Always clears the timeout on completion.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  callerSignal?: AbortSignal,
): Promise<Response> {
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

export interface PosthogConnectionResponse {
  apiKey?: string;
  region?: string;
  host?: string;
  posthogProjectId?: string | number;
  organizationName?: string;
  projectName?: string;
  status?: string;
  createdAt?: string;
}

export type ConnectionFetch =
  | { kind: 'connected'; connection: PosthogConnectionResponse }
  | { kind: 'not-connected' }
  | { kind: 'forbidden'; message: string }
  | { kind: 'error'; message: string; status?: number };

/**
 * GET /integrations/posthog/v1/connection?project_id=<id>
 *
 * Endpoint is owned by cloud-backend (added in parallel under the same plan).
 * Uses user-level Bearer auth from `insforge login` rather than the project
 * JWT — cloud-backend enforces a membership check on the project.
 *
 * The response shape per spec §7 is:
 *   { apiKey, region, host, posthogProjectId, organizationName, projectName, status, createdAt }
 *
 * Coded defensively because the parallel agent may land an early version
 * with fewer fields; we only require `apiKey` and `status` to proceed.
 *
 * Returns a tagged union rather than throwing on the common 404 case so the
 * caller can decide between "trigger browser flow" and "real error".
 */
export async function fetchPosthogConnection(
  projectId: string,
  jwt: string,
  apiUrl?: string,
  signal?: AbortSignal,
): Promise<ConnectionFetch> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const url = `${baseUrl}/integrations/posthog/v1/connection?project_id=${encodeURIComponent(projectId)}`;

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

  // The cloud-backend may legitimately return 200 with `null` or `{}` while
  // the connection is still being created (eager-create idempotency, race
  // with OAuth callback). Treat anything missing `apiKey` as not-connected
  // so the caller keeps polling instead of declaring success early.
  const conn = (data ?? {}) as PosthogConnectionResponse;
  if (!conn.apiKey) {
    return { kind: 'not-connected' };
  }

  // Spec §5.2 + §3.1: only treat status==='active' as ready. If the parallel
  // backend agent hasn't shipped status yet, fall back to "apiKey present
  // means active" so we don't spin forever on an older deploy.
  if (conn.status && conn.status !== 'active') {
    return { kind: 'not-connected' };
  }

  return { kind: 'connected', connection: conn };
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
 * deadline elapses, or the user aborts. 403 short-circuits (it's not going
 * to flip to allowed by retrying); 4xx and transient 5xx are tolerated up to
 * `maxTransientRetries` consecutive failures.
 */
export async function pollPosthogConnection(
  projectId: string,
  jwt: string,
  opts: PollOptions,
  apiUrl?: string,
): Promise<PosthogConnectionResponse> {
  const start = Date.now();
  let consecutiveErrors = 0;

  for (;;) {
    if (opts.signal?.aborted) {
      throw new CLIError('Connection wait cancelled.');
    }

    const elapsed = Date.now() - start;
    if (elapsed >= opts.timeoutMs) {
      throw new CLIError(
        'Timed out waiting for PostHog connection. Re-run `insforge posthog setup` after authorizing.',
      );
    }
    opts.onTick?.(elapsed);

    const result = await fetchPosthogConnection(projectId, jwt, apiUrl, opts.signal);

    switch (result.kind) {
      case 'connected':
        return result.connection;
      case 'forbidden':
        throw new CLIError(`Forbidden: ${result.message}`, 5);
      case 'error':
        consecutiveErrors += 1;
        if (consecutiveErrors > opts.maxTransientRetries) {
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

export type PosthogCliStartResponse =
  | { type: 'connected' }
  | { type: 'authorize'; authorizeUrl: string };

/**
 * GET /integrations/posthog/v1/cli-start?p=<projectId>
 *
 * Asks cloud-backend whether this project is already connected (or can be
 * inline auto-provisioned for new users) — in which case we skip the browser
 * hop entirely. Otherwise returns a direct PostHog `authorizeUrl` that the
 * user must consent at; the URL points straight at posthog.com (no Insforge
 * dashboard in the path).
 */
export async function startPosthogCliFlow(
  projectId: string,
  jwt: string,
  apiUrl?: string,
): Promise<PosthogCliStartResponse> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const url = `${baseUrl}/integrations/posthog/v1/cli-start?p=${encodeURIComponent(projectId)}`;

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
    throw new CLIError(`Failed to start PostHog connect flow: ${formatFetchError(err, url)}`);
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
        `PostHog connect flow unavailable (HTTP 404): ${msg}. Check that the project is linked.`,
      );
    }
    throw new CLIError(`PostHog cli-start failed (HTTP ${res.status}): ${msg}`);
  }

  const data = (await res.json().catch(() => ({}))) as Partial<PosthogCliStartResponse> & {
    authorizeUrl?: string;
  };

  if (data.type === 'connected') {
    return { type: 'connected' };
  }
  if (data.type === 'authorize' && typeof data.authorizeUrl === 'string' && data.authorizeUrl) {
    return { type: 'authorize', authorizeUrl: data.authorizeUrl };
  }
  throw new CLIError('PostHog cli-start returned an unexpected response shape.');
}

export interface PosthogCliCredentials {
  apiKey: string;            // phc_
  personalApiKey: string;    // phx_
  posthogProjectId: string | number;
  region: string;
  host: string;
  status?: string;
}

/**
 * GET /integrations/posthog/v1/cli-credentials?project_id=<id>
 *
 * Returns phx_ in addition to phc_ so the CLI can spawn
 * `npx @posthog/wizard --ci --api-key <phx_>`. Same membership rules as
 * /connection — gated by `authenticate` middleware on cloud-backend.
 */
export async function fetchPosthogCliCredentials(
  projectId: string,
  jwt: string,
  apiUrl?: string,
): Promise<PosthogCliCredentials> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const url = `${baseUrl}/integrations/posthog/v1/cli-credentials?project_id=${encodeURIComponent(projectId)}`;

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
    throw new CLIError(`Failed to fetch CLI credentials: ${formatFetchError(err, url)}`);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CLIError(
      `Failed to fetch CLI credentials (HTTP ${res.status}): ${body.error ?? res.statusText}`,
    );
  }

  const data = (await res.json()) as Partial<PosthogCliCredentials>;
  if (!data.apiKey || !data.personalApiKey || !data.posthogProjectId || !data.region || !data.host) {
    throw new CLIError('CLI credentials response is missing required fields.');
  }
  return data as PosthogCliCredentials;
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
