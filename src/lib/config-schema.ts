// CLI/src/lib/config-schema.ts

/**
 * The shape of insforge.toml after parsing. v1 MVP scope: only the
 * [auth] allowed_redirect_urls field is wired. Every future section
 * (SMTP, OAuth providers, deployments, etc.) extends this type.
 */
export interface InsforgeConfig {
  project_id?: string;
  auth?: AuthConfig;
  deployments?: DeploymentsConfig;
}

export interface AuthConfig {
  allowed_redirect_urls?: string[];
}

export interface DeploymentsConfig {
  // null clears the slug; absent in TOML means default-keep.
  subdomain?: string | null;
}

export class ConfigValidationError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`config.${path}: ${message}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates a parsed TOML object against the v1 schema.
 * Throws ConfigValidationError with the path of the first violation.
 */
export function validateConfig(input: unknown): InsforgeConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError('', 'must be an object');
  }
  const obj = input as Record<string, unknown>;
  const out: InsforgeConfig = {};

  if ('project_id' in obj) {
    if (typeof obj.project_id !== 'string') {
      throw new ConfigValidationError('project_id', 'must be a string');
    }
    out.project_id = obj.project_id;
  }

  if ('auth' in obj) out.auth = validateAuth(obj.auth);
  if ('deployments' in obj) out.deployments = validateDeployments(obj.deployments);

  return out;
}

function validateDeployments(input: unknown): DeploymentsConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError('deployments', 'must be an object');
  }
  const obj = input as Record<string, unknown>;
  const out: DeploymentsConfig = {};

  if ('subdomain' in obj) {
    const v = obj.subdomain;
    // Accept null (clear slug) or string. Slug format validation lives on
    // the backend (single source of truth: updateSlugRequestSchema) so the
    // CLI doesn't drift from server rules.
    if (v !== null && typeof v !== 'string') {
      throw new ConfigValidationError(
        'deployments.subdomain',
        'must be a string or null',
      );
    }
    out.subdomain = v;
  }

  return out;
}

function validateAuth(input: unknown): AuthConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError('auth', 'must be an object');
  }
  const obj = input as Record<string, unknown>;
  const out: AuthConfig = {};

  if ('allowed_redirect_urls' in obj) {
    const v = obj.allowed_redirect_urls;
    if (!Array.isArray(v) || !v.every((u) => typeof u === 'string')) {
      throw new ConfigValidationError(
        'auth.allowed_redirect_urls',
        'must be an array of strings',
      );
    }
    out.allowed_redirect_urls = v;
  }

  return out;
}
