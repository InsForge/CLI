import type { Command } from 'commander';

export class CLIError extends Error {
  constructor(
    message: string,
    public exitCode: number = 1,
    public code?: string,
  ) {
    super(message);
    this.name = 'CLIError';
  }
}

export class AuthError extends CLIError {
  constructor(message: string = 'Not authenticated. Run `npx @insforge/cli login` first.') {
    super(message, 2, 'AUTH_ERROR');
  }
}

export class ProjectNotLinkedError extends CLIError {
  constructor() {
    super('No project linked. Run `npx @insforge/cli link` first.', 3, 'PROJECT_NOT_LINKED');
  }
}

export class NotFoundError extends CLIError {
  constructor(resource: string) {
    super(`${resource} not found.`, 4, 'NOT_FOUND');
  }
}

export class PermissionError extends CLIError {
  constructor(message: string = 'Permission denied.') {
    super(message, 5, 'PERMISSION_DENIED');
  }
}

/**
 * Format a Node fetch error with actionable context.
 *
 * Node's undici-based fetch throws a generic Error with `message: 'fetch failed'`
 * for any network-layer failure (DNS, connect, TLS, reset, timeout). The real
 * reason sits on `err.cause` with a `code` like ENOTFOUND / ECONNREFUSED /
 * ETIMEDOUT / UND_ERR_CONNECT_TIMEOUT / CERT_HAS_EXPIRED, etc. Unpack it so
 * users see something actionable instead of "fetch failed".
 */
export function formatFetchError(err: unknown, url: string): string {
  if (!(err instanceof Error)) return `Network request to ${url} failed: ${String(err)}`;
  if (err.message !== 'fetch failed') return err.message;

  const cause = (err as { cause?: unknown }).cause;
  const code =
    (cause as { code?: string } | undefined)?.code ??
    (cause as { errno?: string } | undefined)?.errno;
  const causeMsg =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined;

  let host = url;
  try { host = new URL(url).host; } catch { /* url may already be a host */ }

  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Cannot resolve ${host} (DNS lookup failed: ${code}). Check your internet connection or DNS settings.`;
    case 'ECONNREFUSED':
      return `Connection to ${host} refused. The server may be down or blocked by a firewall.`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `Connection to ${host} timed out. Check your network, VPN, or proxy settings.`;
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return `Connection to ${host} was reset. A proxy, VPN, or firewall may be interfering.`;
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return `TLS certificate error contacting ${host} (${code}). Your network may be intercepting HTTPS (corporate proxy / VPN).`;
  }

  if (code) return `Network error contacting ${host}: ${code}${causeMsg ? ` — ${causeMsg}` : ''}`;
  if (causeMsg) return `Network error contacting ${host}: ${causeMsg}`;
  return `Network error contacting ${host}.`;
}

/**
 * Extract error message from a deployment's metadata field.
 * DeploymentSchema stores errors in metadata.error.errorMessage rather than a top-level field.
 */
export function getDeploymentError(metadata: Record<string, unknown> | null): string | null {
  if (!metadata || typeof metadata.error !== 'object' || !metadata.error) return null;
  return (metadata.error as { errorMessage?: string }).errorMessage ?? null;
}

export function handleError(err: unknown, json: boolean): never {
  if (err instanceof CLIError) {
    if (json) {
      console.error(JSON.stringify({ error: err.message, code: err.code }));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(err.exitCode);
  }

  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    console.error(JSON.stringify({ error: message, code: 'UNKNOWN_ERROR' }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
}

export function getJsonFlag(cmd: Command): boolean {
  let root: Command = cmd;
  while (root.parent) {
    root = root.parent;
  }
  return root.opts().json ?? false;
}

export function getRootOpts(cmd: Command): { json: boolean; apiUrl?: string; yes: boolean } {
  let root: Command = cmd;
  while (root.parent) {
    root = root.parent;
  }
  const opts = root.opts();
  return {
    json: opts.json ?? false,
    apiUrl: opts.apiUrl,
    yes: opts.yes ?? false,
  };
}
