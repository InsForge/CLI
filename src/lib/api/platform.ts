import { getAccessToken, getPlatformApiUrl } from '../config.js';
import { AuthError, CLIError, formatFetchError } from '../errors.js';
import { refreshAccessToken } from '../credentials.js';
import type {
  ApiKeyResponse,
  Backup,
  BillingCycles,
  Branch,
  BranchMode,
  CheckoutSession,
  CreditBalance,
  DiffResult,
  PaymentRecord,
  PortalSession,
  RedeemResult,
  ReferralLink,
  LatestBackup,
  LatestVersionResponse,
  LoginResponse,
  Member,
  MemberRole,
  MembersResponse,
  MergeConflictResponse,
  MergeExecuteResponse,
  Organization,
  OrgUsage,
  Project,
  SubscriptionStatus,
  UpdateProjectBody,
  UpgradeInstanceBody,
  UpgradeInstanceResult,
  User,
} from '../../types.js';

export interface PlatformFetchOptions extends RequestInit {
  /**
   * HTTP status codes that should be returned to the caller instead of
   * thrown as CLIError. The 401-refresh path is unaffected. Use when the
   * caller wants to render a structured error body (e.g. merge 409).
   */
  passThroughStatuses?: number[];
}

export async function platformFetch(
  path: string,
  options: PlatformFetchOptions = {},
  apiUrl?: string,
): Promise<Response> {
  const { passThroughStatuses, ...fetchOptions } = options;
  const baseUrl = getPlatformApiUrl(apiUrl);
  const token = getAccessToken();
  if (!token) {
    throw new AuthError();
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...(fetchOptions.headers as Record<string, string> ?? {}),
  };

  const fullUrl = `${baseUrl}${path}`;
  if (process.env.INSFORGE_DEBUG) {
    console.error(`[DEBUG] ${fetchOptions.method ?? 'GET'} ${fullUrl}`);
    console.error(`[DEBUG] Headers: ${JSON.stringify(headers, null, 2)}`);
    if (fetchOptions.body) {
      console.error(`[DEBUG] Body: ${typeof fetchOptions.body === 'string' ? fetchOptions.body : JSON.stringify(fetchOptions.body)}`);
    }
  }

  let res: Response;
  try {
    res = await fetch(fullUrl, { ...fetchOptions, headers });
  } catch (err) {
    throw new CLIError(formatFetchError(err, fullUrl));
  }

  // Auto-refresh on 401
  if (res.status === 401) {
    const newToken = await refreshAccessToken(apiUrl);
    headers.Authorization = `Bearer ${newToken}`;
    let retryRes: Response;
    try {
      retryRes = await fetch(fullUrl, { ...fetchOptions, headers });
    } catch (err) {
      throw new CLIError(formatFetchError(err, fullUrl));
    }
    if (passThroughStatuses?.includes(retryRes.status)) {
      return retryRes;
    }
    if (!retryRes.ok) {
      const err = await retryRes.json().catch(() => ({})) as { error?: string };
      throw new CLIError(err.error ?? `Request failed: ${retryRes.status}`, retryRes.status === 403 ? 5 : 1);
    }
    return retryRes;
  }

  if (passThroughStatuses?.includes(res.status)) {
    return res;
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

// --- Project lifecycle ---

export async function updateProject(
  projectId: string,
  body: UpdateProjectBody,
  apiUrl?: string,
): Promise<Project> {
  const res = await platformFetch(`/projects/v1/${projectId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, apiUrl);
  const data = await res.json() as { project?: Project };
  return data.project ?? (data as unknown as Project);
}

export async function deleteProject(projectId: string, apiUrl?: string): Promise<void> {
  await platformFetch(`/projects/v1/${projectId}`, { method: 'DELETE' }, apiUrl);
}

export async function transferProject(
  projectId: string,
  targetOrganizationId: string,
  apiUrl?: string,
): Promise<Project> {
  const res = await platformFetch(`/projects/v1/${projectId}/transfer`, {
    method: 'POST',
    body: JSON.stringify({ targetOrganizationId }),
  }, apiUrl);
  const data = await res.json() as { project?: Project };
  return data.project ?? (data as unknown as Project);
}

export async function restoreProject(projectId: string, apiUrl?: string): Promise<Project> {
  const res = await platformFetch(
    `/projects/v1/${projectId}/restore`,
    { method: 'POST' },
    apiUrl,
  );
  const data = await res.json() as { project?: Project };
  return data.project ?? (data as unknown as Project);
}

export async function upgradeInstance(
  projectId: string,
  body: UpgradeInstanceBody,
  apiUrl?: string,
): Promise<UpgradeInstanceResult> {
  const res = await platformFetch(`/projects/v1/${projectId}/upgrade-instance`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, apiUrl);
  return await res.json() as UpgradeInstanceResult;
}

/**
 * The current latest InsForge OSS version. Resolved by the platform from the
 * default tag in the OSS docker-compose.yml. Public endpoint, but we reuse
 * platformFetch (the auth header is harmless) since callers are authenticated.
 */
export async function getLatestInsforgeVersion(apiUrl?: string): Promise<string> {
  const res = await platformFetch('/platform/insforge/latest-version', {}, apiUrl);
  const data = await res.json() as LatestVersionResponse;
  return data.version;
}

/**
 * Update a project to a specific InsForge OSS version. The platform has no
 * dedicated "update version" route — restart with an explicit
 * `insforgeOssVersion` pins the tag in the instance `.env` and redeploys
 * (the `generateUpdateCommands` path). This mirrors the dashboard's
 * "update to latest" button, which always passes the resolved version
 * explicitly rather than relying on the unpinned-restart fallback.
 *
 * `wait=true` sets `waitForCompletion` so the call blocks until the restart
 * job finishes instead of returning while it's still queued.
 */
export async function restartProjectVersion(
  projectId: string,
  insforgeOssVersion: string,
  wait: boolean,
  apiUrl?: string,
): Promise<Project> {
  const params = new URLSearchParams({ insforgeOssVersion });
  if (wait) params.set('waitForCompletion', 'true');
  const res = await platformFetch(
    `/projects/v1/${projectId}/restart?${params.toString()}`,
    { method: 'POST' },
    apiUrl,
  );
  const data = await res.json() as { project?: Project };
  return data.project ?? (data as unknown as Project);
}

// --- Billing / usage ---

export async function getSubscriptionStatus(orgId: string, apiUrl?: string): Promise<SubscriptionStatus> {
  const res = await platformFetch(`/organizations/v1/${orgId}/subscription-status`, {}, apiUrl);
  return await res.json() as SubscriptionStatus;
}

export async function getCredits(orgId: string, apiUrl?: string): Promise<CreditBalance> {
  const res = await platformFetch(`/billing/v1/${orgId}/credits`, {}, apiUrl);
  return await res.json() as CreditBalance;
}

export async function getPaymentHistory(orgId: string, apiUrl?: string): Promise<PaymentRecord[]> {
  const res = await platformFetch(`/organizations/v1/${orgId}/payment-history`, {}, apiUrl);
  const data = await res.json() as { payments?: PaymentRecord[] };
  return data.payments ?? [];
}

export async function getBillingCycles(orgId: string, apiUrl?: string): Promise<BillingCycles> {
  const res = await platformFetch(`/organizations/v1/${orgId}/billing-cycles`, {}, apiUrl);
  return await res.json() as BillingCycles;
}

/**
 * Create a Stripe Checkout session to upgrade an existing org to `plan`.
 * Returns a hosted checkout URL the caller opens in a browser to complete
 * payment. Requires the caller to be an org administrator.
 */
export async function createCheckoutSession(
  orgId: string,
  plan: string,
  apiUrl?: string,
): Promise<CheckoutSession> {
  const res = await platformFetch('/billing/v1/stripe/checkout-session', {
    method: 'POST',
    body: JSON.stringify({ organizationId: orgId, plan }),
  }, apiUrl);
  return await res.json() as CheckoutSession;
}

/** Create a Stripe customer-portal session (manage subscription / payment method). */
export async function createPortalSession(orgId: string, apiUrl?: string): Promise<PortalSession> {
  const res = await platformFetch('/billing/v1/stripe/portal-session', {
    method: 'POST',
    body: JSON.stringify({ organizationId: orgId }),
  }, apiUrl);
  return await res.json() as PortalSession;
}

export async function redeemPromo(orgId: string, code: string, apiUrl?: string): Promise<RedeemResult> {
  const res = await platformFetch('/billing/v1/promo/redeem', {
    method: 'POST',
    body: JSON.stringify({ organizationId: orgId, code }),
  }, apiUrl);
  return await res.json() as RedeemResult;
}

/** Generate (or fetch) the org's referral link. Administrator only. */
export async function getReferralLink(orgId: string, apiUrl?: string): Promise<ReferralLink> {
  const res = await platformFetch(`/billing/v1/${orgId}/referral-link`, { method: 'POST' }, apiUrl);
  return await res.json() as ReferralLink;
}

export async function getOrgUsage(orgId: string, apiUrl?: string): Promise<OrgUsage> {
  const res = await platformFetch(`/usage/v1/organizations/${orgId}`, {}, apiUrl);
  return await res.json() as OrgUsage;
}

// --- Organization management ---

export async function createOrganization(
  body: { name: string; type: string },
  apiUrl?: string,
): Promise<Organization> {
  const res = await platformFetch('/organizations/v1', {
    method: 'POST',
    body: JSON.stringify(body),
  }, apiUrl);
  const data = await res.json() as { organization?: Organization };
  return data.organization ?? (data as unknown as Organization);
}

export async function updateOrganization(
  orgId: string,
  body: { name?: string; type?: string },
  apiUrl?: string,
): Promise<Organization> {
  const res = await platformFetch(`/organizations/v1/${orgId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, apiUrl);
  const data = await res.json() as { organization?: Organization };
  return data.organization ?? (data as unknown as Organization);
}

export async function listMembers(orgId: string, apiUrl?: string): Promise<MembersResponse> {
  const res = await platformFetch(`/organizations/v1/${orgId}/members`, {}, apiUrl);
  const data = await res.json() as Partial<MembersResponse>;
  return { members: data.members ?? [], invitations: data.invitations ?? [] };
}

export async function inviteMember(
  orgId: string,
  email: string,
  role: MemberRole | undefined,
  apiUrl?: string,
): Promise<{ id: string; email: string; role: MemberRole; expires_at: string }> {
  const body: Record<string, string> = { email };
  if (role) body.role = role;
  const res = await platformFetch(`/organizations/v1/${orgId}/members/invite`, {
    method: 'POST',
    body: JSON.stringify(body),
  }, apiUrl);
  type Invite = { id: string; email: string; role: MemberRole; expires_at: string };
  const data = await res.json() as { invitation?: Invite };
  return data.invitation ?? (data as unknown as Invite);
}

export async function removeMember(orgId: string, memberId: string, apiUrl?: string): Promise<void> {
  await platformFetch(
    `/organizations/v1/${orgId}/members/${memberId}`,
    { method: 'DELETE' },
    apiUrl,
  );
}

export async function updateMemberRole(
  orgId: string,
  memberId: string,
  role: MemberRole,
  apiUrl?: string,
): Promise<Member> {
  const res = await platformFetch(`/organizations/v1/${orgId}/members/${memberId}/role`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  }, apiUrl);
  const data = await res.json() as { member?: Member };
  return data.member ?? (data as unknown as Member);
}

// --- Backups ---

export async function listBackups(projectId: string, apiUrl?: string): Promise<Backup[]> {
  const res = await platformFetch(`/projects/v1/${projectId}/backups`, {}, apiUrl);
  const data = await res.json() as { backups?: Backup[] };
  return data.backups ?? [];
}

export async function getLatestBackup(projectId: string, apiUrl?: string): Promise<LatestBackup | null> {
  const res = await platformFetch(
    `/projects/v1/${projectId}/backup/latest`,
    { passThroughStatuses: [404] },
    apiUrl,
  );
  if (res.status === 404) return null;
  return await res.json() as LatestBackup;
}

export async function createBackup(
  projectId: string,
  name: string | undefined,
  wait: boolean,
  apiUrl?: string,
): Promise<{ message: string; project: { id: string; name: string; status: string } }> {
  const query = wait ? '?waitForCompletion=true' : '';
  const res = await platformFetch(`/projects/v1/${projectId}/backup${query}`, {
    method: 'POST',
    body: JSON.stringify(name ? { name } : {}),
  }, apiUrl);
  return await res.json() as { message: string; project: { id: string; name: string; status: string } };
}

export async function renameBackup(
  projectId: string,
  backupId: string,
  name: string | null,
  apiUrl?: string,
): Promise<{ id: string; name: string | null }> {
  const res = await platformFetch(`/projects/v1/${projectId}/backups/${backupId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  }, apiUrl);
  return await res.json() as { id: string; name: string | null };
}

export async function deleteBackup(projectId: string, backupId: string, apiUrl?: string): Promise<void> {
  await platformFetch(
    `/projects/v1/${projectId}/backups/${backupId}`,
    { method: 'DELETE' },
    apiUrl,
  );
}

export async function restoreBackup(projectId: string, backupId: string, apiUrl?: string): Promise<void> {
  await platformFetch(
    `/projects/v1/${projectId}/backups/${backupId}/restore`,
    { method: 'POST' },
    apiUrl,
  );
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
 * body on 409. The 409 status is passed through platformFetch so callers
 * can render the diff/conflict structure directly while still inheriting
 * the auto-401-refresh and debug logging behavior.
 */
export async function mergeBranchExecuteApi(
  branchId: string,
  apiUrl?: string,
): Promise<{ ok: true; result: MergeExecuteResponse } | { ok: false; conflict: MergeConflictResponse }> {
  const res = await platformFetch(
    `/projects/v1/branches/${branchId}/merge`,
    { method: 'POST', passThroughStatuses: [409] },
    apiUrl,
  );
  if (res.status === 409) {
    return { ok: false, conflict: await res.json() as MergeConflictResponse };
  }
  return { ok: true, result: await res.json() as MergeExecuteResponse };
}

