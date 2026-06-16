import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLIError } from './errors.js';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_OAUTH_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
const CLOUDFLARE_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
const CLOUDFLARE_OAUTH_REDIRECT_URI = 'http://127.0.0.1:8787/callback';
const CLOUDFLARE_OAUTH_CLIENT_ID = '18cf4d9bc2f1b53f205cf92ec4f143c8';
const CLOUDFLARE_OAUTH_SCOPES = [
  'registrar-domains.admin',
  'registrar-domains.read',
  'dns.write',
  'dns.read',
  'zone.write',
  'zone.read',
  'account-settings.read',
];
const GLOBAL_DIR = join(homedir(), '.insforge');
const CLOUDFLARE_FILE = join(GLOBAL_DIR, 'cloudflare.json');

export interface CloudflareCredentials {
  accountId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface CloudflareOAuthCallbackResult {
  code: string;
  state: string;
}

export interface CloudflareAccount {
  id: string;
  name: string;
  type?: string;
}

export interface CloudflarePricing {
  currency: string;
  registration_cost: string;
  renewal_cost: string;
}

export interface CloudflareDomainCandidate {
  name: string;
  registrable: boolean;
  tier?: string;
  reason?: string;
  pricing?: CloudflarePricing;
}

export interface CloudflareRegistrationWorkflow {
  domain_name: string;
  state: 'in_progress' | 'succeeded' | 'failed' | 'action_required' | 'blocked' | string;
  completed: boolean;
  created_at?: string;
  updated_at?: string;
  context?: {
    registration?: CloudflareRegistration;
  };
  links?: {
    self?: string;
    resource?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

export interface CloudflareRegistration {
  domain_name: string;
  status: string;
  created_at?: string;
  expires_at?: string;
  auto_renew?: boolean;
  privacy_mode?: string;
  locked?: boolean;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status?: string;
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  errors?: Array<{ code?: number | string; message?: string }>;
  messages?: Array<{ code?: number | string; message?: string }>;
  result: T;
}

function ensureGlobalDir(): void {
  if (!existsSync(GLOBAL_DIR)) {
    mkdirSync(GLOBAL_DIR, { recursive: true });
  }
}

function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function getCloudflareOAuthClientId(): string {
  return process.env.INSFORGE_CLOUDFLARE_OAUTH_CLIENT_ID ?? CLOUDFLARE_OAUTH_CLIENT_ID;
}

function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(64));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function generateState(): string {
  return base64url(randomBytes(32));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function buildCloudflareAuthorizeUrl(params: {
  clientId?: string;
  redirectUri?: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
}): string {
  const url = new URL(CLOUDFLARE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', params.clientId ?? getCloudflareOAuthClientId());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri ?? CLOUDFLARE_OAUTH_REDIRECT_URI);
  url.searchParams.set('scope', (params.scopes ?? CLOUDFLARE_OAUTH_SCOPES).join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function startCloudflareCallbackServer(expectedState: string): Promise<{
  result: Promise<CloudflareOAuthCallbackResult>;
  close: () => void;
}> {
  return new Promise((resolveServer, rejectServer) => {
    let resolveResult: (value: CloudflareOAuthCallbackResult) => void;
    let rejectResult: (reason: Error) => void;

    const resultPromise = new Promise<CloudflareOAuthCallbackResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', CLOUDFLARE_OAUTH_REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        const desc = url.searchParams.get('error_description') ?? error;
        const safeDesc = escapeHtml(desc);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h2>Cloudflare authorization failed</h2><p>${safeDesc}</p><p>You can close this window.</p></body></html>`);
        rejectResult(new Error(desc));
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Invalid Cloudflare callback</h2><p>Missing authorization code.</p></body></html>');
        rejectResult(new Error('Invalid Cloudflare callback: missing authorization code or state.'));
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Invalid Cloudflare callback</h2><p>State mismatch.</p></body></html>');
        rejectResult(new Error('Cloudflare OAuth state mismatch.'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Cloudflare connected</h2><p>You can close this window and return to the terminal.</p></body></html>');
      resolveResult({ code, state });
    });

    server.once('error', (err) => {
      rejectServer(new CLIError(
        `Could not start Cloudflare OAuth callback server on ${CLOUDFLARE_OAUTH_REDIRECT_URI}: ${err.message}`,
        1,
        'CLOUDFLARE_OAUTH_CALLBACK_UNAVAILABLE',
      ));
    });

    server.listen(8787, '127.0.0.1', () => {
      resolveServer({
        result: resultPromise,
        close: () => {
          server.close();
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
        },
      });
    });

    setTimeout(() => {
      rejectResult(new Error('Cloudflare authorization timed out. Please try again.'));
      server.close();
    }, 5 * 60 * 1000).unref();
  });
}

async function exchangeCloudflareOAuthCode(params: {
  code: string;
  codeVerifier: string;
}): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
  const res = await fetch(CLOUDFLARE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: getCloudflareOAuthClientId(),
      code: params.code,
      redirect_uri: CLOUDFLARE_OAUTH_REDIRECT_URI,
      code_verifier: params.codeVerifier,
    }),
  });

  const body = await res.json().catch(() => null) as
    | { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }
    | null;
  if (!res.ok || !body?.access_token) {
    throw new CLIError(
      body?.error_description ?? body?.error ?? `Cloudflare token exchange failed (HTTP ${res.status})`,
      1,
      'CLOUDFLARE_OAUTH_TOKEN_EXCHANGE_FAILED',
      res.status,
    );
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in,
    scope: body.scope,
  };
}

async function refreshCloudflareCredentials(creds: CloudflareCredentials): Promise<CloudflareCredentials> {
  if (!creds.refreshToken) {
    return creds;
  }

  const res = await fetch(CLOUDFLARE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: getCloudflareOAuthClientId(),
      refresh_token: creds.refreshToken,
    }),
  });

  const body = await res.json().catch(() => null) as
    | { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string }
    | null;
  if (!res.ok || !body?.access_token) {
    throw new CLIError(
      body?.error_description ?? body?.error ?? `Cloudflare token refresh failed (HTTP ${res.status})`,
      2,
      'CLOUDFLARE_OAUTH_REFRESH_FAILED',
      res.status,
    );
  }

  const refreshed: CloudflareCredentials = {
    accountId: creds.accountId,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? creds.refreshToken,
    expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    scope: body.scope ?? creds.scope,
  };
  saveCloudflareCredentials(refreshed);
  return refreshed;
}

function isExpiringSoon(creds: CloudflareCredentials): boolean {
  return creds.expiresAt !== undefined && creds.expiresAt <= Date.now() + 60_000;
}

export function saveCloudflareCredentials(creds: CloudflareCredentials): void {
  ensureGlobalDir();
  writeFileSync(CLOUDFLARE_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(CLOUDFLARE_FILE, 0o600);
}

export function getCloudflareCredentials(): CloudflareCredentials | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessToken = process.env.CLOUDFLARE_ACCESS_TOKEN;
  if (accountId && accessToken) {
    return { accountId, accessToken };
  }

  if (!existsSync(CLOUDFLARE_FILE)) {
    return null;
  }

  let raw: Partial<CloudflareCredentials>;
  try {
    raw = JSON.parse(readFileSync(CLOUDFLARE_FILE, 'utf-8')) as Partial<CloudflareCredentials>;
  } catch {
    return null;
  }
  if (!raw.accountId || !raw.accessToken) {
    return null;
  }
  return {
    accountId: raw.accountId,
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    expiresAt: raw.expiresAt,
    scope: raw.scope,
  };
}

export async function requireCloudflareCredentials(): Promise<CloudflareCredentials> {
  const creds = getCloudflareCredentials();
  if (!creds) {
    throw new CLIError(
      'Cloudflare is not connected. Run `npx @insforge/cli domains cloudflare login` or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_ACCESS_TOKEN.',
      2,
      'CLOUDFLARE_AUTH_REQUIRED',
    );
  }
  return isExpiringSoon(creds) ? await refreshCloudflareCredentials(creds) : creds;
}

export async function listCloudflareAccounts(creds?: CloudflareCredentials): Promise<CloudflareAccount[]> {
  return cloudflareFetch<CloudflareAccount[]>('/accounts', {}, creds);
}

export async function performCloudflareOAuthLogin(params: {
  accountId?: string;
  skipBrowser?: boolean;
  selectAccount?: (accounts: CloudflareAccount[]) => Promise<string>;
}): Promise<CloudflareCredentials> {
  const pkce = generatePkce();
  const state = generateState();
  const { result, close } = await startCloudflareCallbackServer(state);
  const authUrl = buildCloudflareAuthorizeUrl({
    state,
    codeChallenge: pkce.codeChallenge,
  });

  process.stderr.write(`\nTo connect Cloudflare, open this URL in your browser:\n\n  ${authUrl}\n\n`);
  if (!params.skipBrowser) {
    try {
      const open = (await import('open')).default;
      await open(authUrl);
    } catch {
      // Best-effort; URL is printed above.
    }
  }

  try {
    const callback = await result;
    const tokens = await exchangeCloudflareOAuthCode({
      code: callback.code,
      codeVerifier: pkce.codeVerifier,
    });
    const discoveredCreds: CloudflareCredentials = {
      accountId: params.accountId ?? '',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      scope: tokens.scope,
    };
    if (!params.accountId) {
      const accounts = await listCloudflareAccounts(discoveredCreds).catch((err: unknown) => {
        throw new CLIError(
          err instanceof Error
            ? `Could not discover Cloudflare accounts: ${err.message}.`
            : 'Could not discover Cloudflare accounts.',
          1,
          'CLOUDFLARE_ACCOUNT_DISCOVERY_FAILED',
        );
      });

      if (accounts.length === 0) {
        throw new CLIError(
          'Cloudflare OAuth succeeded, but account discovery returned no accounts.',
          1,
          'CLOUDFLARE_ACCOUNT_NOT_FOUND',
        );
      }
      else if (accounts.length === 1) {
        discoveredCreds.accountId = accounts[0].id;
      } else if (params.selectAccount) {
        discoveredCreds.accountId = await params.selectAccount(accounts);
      } else {
        throw new CLIError(
          `Cloudflare returned ${accounts.length} accounts. Re-run with --account-id <id>.`,
          1,
          'CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED',
        );
      }
    }

    const creds: CloudflareCredentials = discoveredCreds;
    saveCloudflareCredentials(creds);
    return creds;
  } finally {
    close();
  }
}

function formatCloudflareErrors(errors: CloudflareApiResponse<unknown>['errors']): string | null {
  if (!errors || errors.length === 0) return null;
  return errors
    .map((err) => [err.code, err.message].filter(Boolean).join(': '))
    .filter(Boolean)
    .join('; ');
}

async function cloudflareFetch<T>(
  path: string,
  options: RequestInit = {},
  creds?: CloudflareCredentials,
): Promise<T> {
  let activeCreds = creds ?? await requireCloudflareCredentials();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${activeCreds.accessToken}`,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };

  let res = await fetch(`${CLOUDFLARE_API_BASE}${path}`, { ...options, headers });
  if (res.status === 401 && activeCreds.refreshToken) {
    activeCreds = await refreshCloudflareCredentials(activeCreds);
    res = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
      ...options,
      headers: {
        ...headers,
        Authorization: `Bearer ${activeCreds.accessToken}`,
      },
    });
  }
  const body = await res.json().catch(() => null) as CloudflareApiResponse<T> | null;
  if (!res.ok || !body?.success) {
    const message =
      formatCloudflareErrors(body?.errors) ??
      `Cloudflare request failed: HTTP ${res.status}`;
    throw new CLIError(message, 1, 'CLOUDFLARE_API_ERROR', res.status);
  }
  return body.result;
}

export async function searchCloudflareDomains(
  query: string,
  limit: number,
): Promise<CloudflareDomainCandidate[]> {
  const creds = await requireCloudflareCredentials();
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const result = await cloudflareFetch<{ domains: CloudflareDomainCandidate[] }>(
    `/accounts/${creds.accountId}/registrar/domain-search?${params.toString()}`,
    {},
    creds,
  );
  return result.domains;
}

export async function checkCloudflareDomains(
  domains: string[],
): Promise<CloudflareDomainCandidate[]> {
  const creds = await requireCloudflareCredentials();
  const result = await cloudflareFetch<{ domains: CloudflareDomainCandidate[] }>(
    `/accounts/${creds.accountId}/registrar/domain-check`,
    {
      method: 'POST',
      body: JSON.stringify({ domains }),
    },
    creds,
  );
  return result.domains;
}

export async function registerCloudflareDomain(domain: string): Promise<CloudflareRegistrationWorkflow> {
  const creds = await requireCloudflareCredentials();
  return cloudflareFetch<CloudflareRegistrationWorkflow>(
    `/accounts/${creds.accountId}/registrar/registrations`,
    {
      method: 'POST',
      headers: { Prefer: 'respond-async' },
      body: JSON.stringify({
        domain_name: domain,
        auto_renew: true,
        privacy_mode: 'redaction',
      }),
    },
    creds,
  );
}

export async function getCloudflareRegistrationStatus(domain: string): Promise<CloudflareRegistrationWorkflow> {
  const creds = await requireCloudflareCredentials();
  return cloudflareFetch<CloudflareRegistrationWorkflow>(
    `/accounts/${creds.accountId}/registrar/registrations/${encodeURIComponent(domain)}/registration-status`,
    {},
    creds,
  );
}

export async function getCloudflareRegistration(domain: string): Promise<CloudflareRegistration> {
  const creds = await requireCloudflareCredentials();
  return cloudflareFetch<CloudflareRegistration>(
    `/accounts/${creds.accountId}/registrar/registrations/${encodeURIComponent(domain)}`,
    {},
    creds,
  );
}

export async function findCloudflareZone(name: string): Promise<CloudflareZone | null> {
  const creds = await requireCloudflareCredentials();
  const params = new URLSearchParams({
    name,
    'account.id': creds.accountId,
    per_page: '1',
  });
  const result = await cloudflareFetch<CloudflareZone[]>(`/zones?${params.toString()}`, {}, creds);
  return result[0] ?? null;
}

export async function createCloudflareZone(name: string): Promise<CloudflareZone> {
  const creds = await requireCloudflareCredentials();
  return cloudflareFetch<CloudflareZone>(
    '/zones',
    {
      method: 'POST',
      body: JSON.stringify({
        account: { id: creds.accountId },
        name,
        type: 'full',
      }),
    },
    creds,
  );
}

export async function ensureCloudflareZone(name: string): Promise<CloudflareZone> {
  const existing = await findCloudflareZone(name);
  if (existing) return existing;
  return createCloudflareZone(name);
}

export async function listCloudflareDnsRecords(
  zoneId: string,
  filters: { type?: string; name?: string } = {},
): Promise<CloudflareDnsRecord[]> {
  const params = new URLSearchParams();
  if (filters.type) params.set('type', filters.type);
  if (filters.name) params.set('name', filters.name);
  const query = params.toString();
  const suffix = query ? `?${query}` : '';
  return cloudflareFetch<CloudflareDnsRecord[]>(`/zones/${zoneId}/dns_records${suffix}`);
}

export async function upsertCloudflareDnsRecord(
  zoneId: string,
  record: { type: string; name: string; content: string; ttl?: number; proxied?: boolean },
): Promise<CloudflareDnsRecord> {
  const existing = await listCloudflareDnsRecords(zoneId, {
    type: record.type,
    name: record.name,
  });
  const body = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl ?? 1,
    proxied: record.proxied ?? false,
  };
  const exact = existing.find((entry) => entry.content === record.content);
  const current = record.type.toUpperCase() === 'TXT'
    ? exact
    : exact ?? existing[0];
  if (current) {
    return cloudflareFetch<CloudflareDnsRecord>(
      `/zones/${zoneId}/dns_records/${current.id}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
    );
  }
  return cloudflareFetch<CloudflareDnsRecord>(
    `/zones/${zoneId}/dns_records`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}
