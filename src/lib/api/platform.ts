import { getAccessToken, getPlatformApiUrl } from '../config.js';
import { AuthError, CLIError, formatFetchError } from '../errors.js';
import { refreshAccessToken } from '../credentials.js';
import type {
  ApiKeyResponse,
  Branch,
  BranchMode,
  DiffResult,
  LoginResponse,
  MergeConflictResponse,
  MergeExecuteResponse,
  Organization,
  Project,
  User,
} from '../../types.js';

export async function platformFetch(
  path: string,
  options: RequestInit = {},
  apiUrl?: string,
): Promise<Response> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const token = getAccessToken();
  if (!token) {
    throw new AuthError();
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...(options.headers as Record<string, string> ?? {}),
  };

  const fullUrl = `${baseUrl}${path}`;
  if (process.env.INSFORGE_DEBUG) {
    console.error(`[DEBUG] ${options.method ?? 'GET'} ${fullUrl}`);
    console.error(`[DEBUG] Headers: ${JSON.stringify(headers, null, 2)}`);
    if (options.body) {
      console.error(`[DEBUG] Body: ${typeof options.body === 'string' ? options.body : JSON.stringify(options.body)}`);
    }
  }

  let res: Response;
  try {
    res = await fetch(fullUrl, { ...options, headers });
  } catch (err) {
    throw new CLIError(formatFetchError(err, fullUrl));
  }

  // Auto-refresh on 401
  if (res.status === 401) {
    const newToken = await refreshAccessToken(apiUrl);
    headers.Authorization = `Bearer ${newToken}`;
    let retryRes: Response;
    try {
      retryRes = await fetch(fullUrl, { ...options, headers });
    } catch (err) {
      throw new CLIError(formatFetchError(err, fullUrl));
    }
    if (!retryRes.ok) {
      const err = await retryRes.json().catch(() => ({})) as { error?: string };
      throw new CLIError(err.error ?? `Request failed: ${retryRes.status}`, retryRes.status === 403 ? 5 : 1);
    }
    return retryRes;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; message?: string };
    const msg = err.message ? `${err.error ?? res.status}: ${err.message}` : (err.error ?? `Request failed: ${res.status}`);
    throw new CLIError(msg, res.status === 403 ? 5 : 1);
  }

  return res;
}

// --- Auth ---

export async function login(email: string, password: string, apiUrl?: string): Promise<LoginResponse & { _refreshToken?: string }> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const res = await fetch(`${baseUrl}/auth/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new AuthError(err.error ?? 'Login failed. Check your email and password.');
  }

  // Extract refresh token from Set-Cookie header
  const setCookie = res.headers.get('set-cookie') ?? '';
  const refreshTokenMatch = setCookie.match(/refreshToken=([^;]+)/);
  const data = (await res.json()) as LoginResponse;

  return {
    ...data,
    // Attach refresh token to the response for storage
    _refreshToken: refreshTokenMatch?.[1],
  } as LoginResponse & { _refreshToken?: string };
}

export async function getProfile(apiUrl?: string): Promise<User> {
  const res = await platformFetch('/auth/v1/profile', {}, apiUrl);
  const data = await res.json() as { user?: User };
  return data.user ?? (data as unknown as User);
}

// --- Organizations ---

export async function listOrganizations(apiUrl?: string): Promise<Organization[]> {
  const res = await platformFetch('/organizations/v1', {}, apiUrl);
  const data = await res.json() as { organizations?: Organization[] };
  return data.organizations ?? (data as unknown as Organization[]);
}

// --- Projects ---

export async function listProjects(orgId: string, apiUrl?: string): Promise<Project[]> {
  const res = await platformFetch(`/organizations/v1/${orgId}/projects`, {}, apiUrl);
  const data = await res.json() as { projects?: Project[] };
  return data.projects ?? (data as unknown as Project[]);
}

export async function getProject(projectId: string, apiUrl?: string): Promise<Project> {
  const res = await platformFetch(`/projects/v1/${projectId}`, {}, apiUrl);
  const data = await res.json() as { project?: Project };
  return data.project ?? (data as unknown as Project);
}

export async function getProjectApiKey(projectId: string, apiUrl?: string): Promise<string> {
  const res = await platformFetch(`/projects/v1/${projectId}/access-api-key`, {}, apiUrl);
  const data = (await res.json()) as ApiKeyResponse;
  return data.access_api_key;
}

export async function reportAgentConnected(
  payload: { project_id?: string; app_key?: string },
  apiUrl?: string,
): Promise<void> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getAccessToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  await fetch(`${baseUrl}/tracking/v1/agent-connected`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, client: 'cli' }),
  });
}

export interface DiagnosticRequest {
  project_id: string;
  question: string;
  context: {
    context_version: string;
    metrics?: unknown;
    advisor?: unknown;
    db?: unknown;
    logs?: unknown;
    client_info?: {
      cli_version?: string;
      node_version?: string;
      os?: string;
    };
  };
}

export interface DiagnosticSSEEvent {
  type: 'delta' | 'tool_call' | 'tool_result' | 'done' | 'error';
  data: Record<string, unknown>;
}

export type DiagnosticEventHandler = (event: DiagnosticSSEEvent) => void;

/**
 * Stream diagnostic analysis via SSE. Calls `onEvent` for each SSE event.
 * Returns the raw Response so the caller can handle errors before streaming.
 */
export async function streamDiagnosticAnalysis(
  payload: DiagnosticRequest,
  onEvent: DiagnosticEventHandler,
  apiUrl?: string,
): Promise<void> {
  const res = await platformFetch('/diagnostic/v1/analyze', {
    method: 'POST',
    body: JSON.stringify(payload),
  }, apiUrl);

  const body = res.body;
  if (!body) throw new CLIError('No response body from diagnostic API.');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: DiagnosticSSEEvent['type'] | null = 'delta';

  const VALID_EVENTS = new Set<string>(['delta', 'tool_call', 'tool_result', 'done', 'error']);

  const processLine = (line: string): void => {
    if (line.startsWith('event:')) {
      const evt = line.slice(6).trim();
      currentEvent = VALID_EVENTS.has(evt) ? evt as DiagnosticSSEEvent['type'] : null;
    } else if (line.startsWith('data:')) {
      if (!currentEvent) return;
      const raw = line.slice(5).trim();
      if (!raw) return;
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        onEvent({ type: currentEvent, data });
      } catch {
        // skip malformed JSON
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      processLine(line);
    }
  }

  // Flush remaining bytes from multi-byte sequences
  buffer += decoder.decode();
  if (buffer.trim()) {
    processLine(buffer);
  }
}

export async function rateDiagnosticSession(
  sessionId: string,
  rating: 'helpful' | 'not_helpful' | 'incorrect',
  comment?: string,
  apiUrl?: string,
): Promise<void> {
  const body: Record<string, string> = { rating };
  if (comment) body.comment = comment;
  await platformFetch(`/diagnostic/v1/sessions/${sessionId}/rating`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, apiUrl);
}

export async function createProject(
  orgId: string,
  name: string,
  region?: string,
  apiUrl?: string,
): Promise<Project> {
  const body: Record<string, string> = { name };
  if (region) body.region = region;

  const res = await platformFetch(`/organizations/v1/${orgId}/projects`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, apiUrl);
  const data = await res.json() as { project?: Project };
  return data.project ?? (data as unknown as Project);
}

// --- Branching ---

export async function createBranchApi(
  parentProjectId: string,
  body: { mode: BranchMode; name: string },
  apiUrl?: string,
): Promise<Branch> {
  const res = await platformFetch(`/projects/v1/${parentProjectId}/branches`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, apiUrl);
  const data = await res.json() as { branch: Branch };
  return data.branch;
}

export async function listBranchesApi(parentProjectId: string, apiUrl?: string): Promise<Branch[]> {
  const res = await platformFetch(`/projects/v1/${parentProjectId}/branches`, {}, apiUrl);
  const data = await res.json() as { data?: Branch[] };
  return data.data ?? [];
}

export async function getBranchApi(branchId: string, apiUrl?: string): Promise<Branch> {
  const res = await platformFetch(`/projects/v1/branches/${branchId}`, {}, apiUrl);
  const data = await res.json() as { branch: Branch };
  return data.branch;
}

export async function deleteBranchApi(branchId: string, apiUrl?: string): Promise<void> {
  await platformFetch(`/projects/v1/branches/${branchId}`, { method: 'DELETE' }, apiUrl);
}

/**
 * Trigger an async branch reset. Backend transitions branch_state to
 * 'resetting', kicks off pg_restore from the T0 backup, and returns 202
 * with the post-transition row. Callers should poll getBranchApi until
 * branch_state goes back to 'ready'.
 */
export async function resetBranchApi(branchId: string, apiUrl?: string): Promise<Branch> {
  const res = await platformFetch(
    `/projects/v1/branches/${branchId}/reset`,
    { method: 'POST' },
    apiUrl,
  );
  const data = await res.json() as { branch: Branch };
  return data.branch;
}

export async function mergeBranchDryRunApi(branchId: string, apiUrl?: string): Promise<DiffResult> {
  const res = await platformFetch(
    `/projects/v1/branches/${branchId}/merge?dryRun=true`,
    { method: 'POST' },
    apiUrl,
  );
  return await res.json() as DiffResult;
}

/**
 * Merge execute. Returns the success body on clean merge, or the conflict
 * body on 409. We bypass platformFetch's throw-on-non-2xx for the conflict
 * case so callers can render the diff/conflict structure directly.
 */
export async function mergeBranchExecuteApi(
  branchId: string,
  apiUrl?: string,
): Promise<{ ok: true; result: MergeExecuteResponse } | { ok: false; conflict: MergeConflictResponse }> {
  const baseUrl = getPlatformApiUrl(apiUrl);
  const token = getAccessToken();
  if (!token) throw new AuthError();
  const url = `${baseUrl}/projects/v1/branches/${branchId}/merge`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    throw new CLIError(formatFetchError(err, url));
  }
  if (res.ok) {
    return { ok: true, result: await res.json() as MergeExecuteResponse };
  }
  if (res.status === 409) {
    return { ok: false, conflict: await res.json() as MergeConflictResponse };
  }
  // Other failures: fall through to standard error path.
  const err = await res.json().catch(() => ({})) as { error?: string; message?: string };
  const msg = err.message ? `${err.error ?? res.status}: ${err.message}` : (err.error ?? `Merge failed: ${res.status}`);
  throw new CLIError(msg, res.status === 403 ? 5 : 1);
}

