// CLI/src/lib/config-schema.ts

import { validateSensitiveString } from './config-secrets.js';

/**
 * The shape of insforge.toml after parsing. Sections cover declarative
 * project settings ("dashboard knobs"). Each section maps to a single
 * backend admin endpoint and is gated independently by the capability
 * probe — adding a section here does NOT silently break old backends.
 */
export interface InsforgeConfig {
  project_id?: string;
  auth?: AuthConfig;
  deployments?: DeploymentsConfig;
}

export interface AuthConfig {
  allowed_redirect_urls?: string[];
  smtp?: SmtpConfig;
}

/**
 * SMTP configuration. Mirrors backend `smtpConfigSchema` minus the row
 * metadata (id/createdAt/updatedAt) — TOML is desired state, not the
 * persisted row. The `password` field is required to be an env() ref
 * when present; literal values are rejected at parse time.
 */
export interface SmtpConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  username?: string;
  /** env(NAME) reference; never a literal value. Omit to preserve existing. */
  password?: string;
  sender_email?: string;
  sender_name?: string;
  min_interval_seconds?: number;
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
 * Validates a parsed TOML object against the schema. Throws
 * ConfigValidationError with the path of the first violation.
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

  if ('smtp' in obj) out.smtp = validateSmtp(obj.smtp);

  return out;
}

function validateSmtp(input: unknown): SmtpConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError('auth.smtp', 'must be a table');
  }
  const obj = input as Record<string, unknown>;
  const out: SmtpConfig = {};

  if ('enabled' in obj) {
    if (typeof obj.enabled !== 'boolean') {
      throw new ConfigValidationError('auth.smtp.enabled', 'must be a boolean');
    }
    out.enabled = obj.enabled;
  }

  if ('host' in obj) {
    if (typeof obj.host !== 'string') {
      throw new ConfigValidationError('auth.smtp.host', 'must be a string');
    }
    out.host = obj.host;
  }

  if ('port' in obj) {
    if (
      typeof obj.port !== 'number' ||
      !Number.isInteger(obj.port) ||
      obj.port < 1 ||
      obj.port > 65535
    ) {
      throw new ConfigValidationError(
        'auth.smtp.port',
        'must be an integer between 1 and 65535',
      );
    }
    out.port = obj.port;
  }

  if ('username' in obj) {
    if (typeof obj.username !== 'string') {
      throw new ConfigValidationError('auth.smtp.username', 'must be a string');
    }
    out.username = obj.username;
  }

  if ('password' in obj) {
    // env() ref only — literal passwords are rejected at parse time so the
    // TOML stays git-safe even if a developer pastes one in by mistake.
    out.password = validateSensitiveString(
      'auth.smtp.password',
      obj.password,
      'SMTP_PASSWORD',
    );
  }

  if ('sender_email' in obj) {
    if (typeof obj.sender_email !== 'string') {
      throw new ConfigValidationError('auth.smtp.sender_email', 'must be a string');
    }
    out.sender_email = obj.sender_email;
  }

  if ('sender_name' in obj) {
    if (typeof obj.sender_name !== 'string') {
      throw new ConfigValidationError('auth.smtp.sender_name', 'must be a string');
    }
    out.sender_name = obj.sender_name;
  }

  if ('min_interval_seconds' in obj) {
    if (
      typeof obj.min_interval_seconds !== 'number' ||
      !Number.isInteger(obj.min_interval_seconds) ||
      obj.min_interval_seconds < 0
    ) {
      throw new ConfigValidationError(
        'auth.smtp.min_interval_seconds',
        'must be a non-negative integer',
      );
    }
    out.min_interval_seconds = obj.min_interval_seconds;
  }

  return out;
}
