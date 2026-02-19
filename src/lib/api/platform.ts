import { getAccessToken, getPlatformApiUrl } from '../config.js';
import { AuthError, CLIError } from '../errors.js';
import { refreshAccessToken } from '../credentials.js';
import type {
  ApiKeyResponse,
  LoginResponse,
  Organization,
  Project,
  User,
} from '../../types.js';

async function platformFetch(
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

  const res = await fetch(`${baseUrl}${path}`, { ...options, headers });

  // Auto-refresh on 401
  if (res.status === 401) {
    const newToken = await refreshAccessToken(apiUrl);
    headers.Authorization = `Bearer ${newToken}`;
    const retryRes = await fetch(`${baseUrl}${path}`, { ...options, headers });
    if (!retryRes.ok) {
      const err = await retryRes.json().catch(() => ({})) as { error?: string };
      throw new CLIError(err.error ?? `Request failed: ${retryRes.status}`, retryRes.status === 403 ? 5 : 1);
    }
    return retryRes;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new CLIError(err.error ?? `Request failed: ${res.status}`, res.status === 403 ? 5 : 1);
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

