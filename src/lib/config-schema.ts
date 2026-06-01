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
  storage?: StorageConfig;
  realtime?: RetentionConfig;
  schedules?: RetentionConfig;
  deployments?: DeploymentsConfig;
}

export type VerificationMethod = 'code' | 'link';
export type EmailTemplateType =
  | 'email-verification-code'
  | 'email-verification-link'
  | 'reset-password-code'
  | 'reset-password-link';

export const EMAIL_TEMPLATE_TYPES: EmailTemplateType[] = [
  'email-verification-code',
  'email-verification-link',
  'reset-password-code',
  'reset-password-link',
];

export interface AuthConfig {
  allowed_redirect_urls?: string[];
  require_email_verification?: boolean;
  verify_email_method?: VerificationMethod;
  reset_password_method?: VerificationMethod;
  disable_signup?: boolean;
  password?: PasswordConfig;
  smtp?: SmtpConfig;
  email_templates?: Partial<Record<EmailTemplateType, EmailTemplateConfig>>;
}

/**
 * Password policy enforced at signup / reset. All fields are independent —
 * a partial [auth.password] block in TOML applies only the fields it names,
 * preserving the rest (default-keep). Mirrors the flat camelCase fields the
 * backend exposes on `authConfig` (passwordMinLength, requireNumber, etc.);
 * the nested table is a CLI-side ergonomic — the wire still sends them flat.
 */
export interface PasswordConfig {
  min_length?: number;
  require_number?: boolean;
  require_lowercase?: boolean;
  require_uppercase?: boolean;
  require_special_char?: boolean;
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

export interface EmailTemplateConfig {
  subject: string;
  body_html: string;
}

export interface StorageConfig {
  max_file_size_mb?: number;
}

export interface RetentionConfig {
  /**
   * Positive integer = keep records for N days.
   * 0 or null = disable retention cleanup (wire value: null).
   */
  retention_days?: number | null;
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
  if ('storage' in obj) out.storage = validateStorage(obj.storage);
  if ('realtime' in obj) out.realtime = validateRetentionSection('realtime', obj.realtime);
  if ('schedules' in obj) out.schedules = validateRetentionSection('schedules', obj.schedules);
  if ('deployments' in obj) out.deployments = validateDeployments(obj.deployments);

  return out;
}

function validateStorage(input: unknown): StorageConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError('storage', 'must be an object');
  }
  const obj = input as Record<string, unknown>;
  const out: StorageConfig = {};

  if ('max_file_size_mb' in obj) {
    if (
      typeof obj.max_file_size_mb !== 'number' ||
      !Number.isInteger(obj.max_file_size_mb) ||
      obj.max_file_size_mb < 1 ||
      obj.max_file_size_mb > 200
    ) {
      throw new ConfigValidationError(
        'storage.max_file_size_mb',
        'must be an integer between 1 and 200',
      );
    }
    out.max_file_size_mb = obj.max_file_size_mb;
  }

  return out;
}

function validateRetentionSection(path: 'realtime' | 'schedules', input: unknown): RetentionConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError(path, 'must be an object');
  }
  const obj = input as Record<string, unknown>;
  const out: RetentionConfig = {};

  if ('retention_days' in obj) {
    const v = obj.retention_days;
    if (
      v !== null &&
      (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
    ) {
      throw new ConfigValidationError(
        `${path}.retention_days`,
        'must be a non-negative integer or null',
      );
    }
    out.retention_days = v;
  }

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

  if ('require_email_verification' in obj) {
    if (typeof obj.require_email_verification !== 'boolean') {
      throw new ConfigValidationError(
        'auth.require_email_verification',
        'must be a boolean',
      );
    }
    out.require_email_verification = obj.require_email_verification;
  }

  if ('verify_email_method' in obj) {
    out.verify_email_method = validateVerificationMethod(
      'auth.verify_email_method',
      obj.verify_email_method,
    );
  }

  if ('reset_password_method' in obj) {
    out.reset_password_method = validateVerificationMethod(
      'auth.reset_password_method',
      obj.reset_password_method,
    );
  }

  if ('disable_signup' in obj) {
    if (typeof obj.disable_signup !== 'boolean') {
      throw new ConfigValidationError('auth.disable_signup', 'must be a boolean');
    }
    out.disable_signup = obj.disable_signup;
  }

  if ('password' in obj) out.password = validatePassword(obj.password);
  if ('smtp' in obj) out.smtp = validateSmtp(obj.smtp);
  if ('email_templates' in obj) {
    out.email_templates = validateEmailTemplates(obj.email_templates);
  }

  return out;
}

function validateVerificationMethod(path: string, value: unknown): VerificationMethod {
  if (value !== 'code' && value !== 'link') {
    throw new ConfigValidationError(path, 'must be "code" or "link"');
  }
  return value;
}

function validatePassword(input: unknown): PasswordConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError('auth.password', 'must be a table');
  }
  const obj = input as Record<string, unknown>;
  const out: PasswordConfig = {};

  if ('min_length' in obj) {
    if (
      typeof obj.min_length !== 'number' ||
      !Number.isInteger(obj.min_length) ||
      obj.min_length < 4 ||
      obj.min_length > 128
    ) {
      throw new ConfigValidationError(
        'auth.password.min_length',
        'must be an integer between 4 and 128',
      );
    }
    out.min_length = obj.min_length;
  }

  for (const key of [
    'require_number',
    'require_lowercase',
    'require_uppercase',
    'require_special_char',
  ] as const) {
    if (key in obj) {
      if (typeof obj[key] !== 'boolean') {
        throw new ConfigValidationError(`auth.password.${key}`, 'must be a boolean');
      }
      out[key] = obj[key] as boolean;
    }
  }

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

function validateEmailTemplates(input: unknown): Partial<Record<EmailTemplateType, EmailTemplateConfig>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigValidationError('auth.email_templates', 'must be a table');
  }
  const obj = input as Record<string, unknown>;
  const out: Partial<Record<EmailTemplateType, EmailTemplateConfig>> = {};

  for (const [templateType, value] of Object.entries(obj)) {
    if (!isEmailTemplateType(templateType)) {
      throw new ConfigValidationError(
        `auth.email_templates.${templateType}`,
        `must be one of: ${EMAIL_TEMPLATE_TYPES.join(', ')}`,
      );
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ConfigValidationError(
        `auth.email_templates.${templateType}`,
        'must be a table',
      );
    }
    const template = value as Record<string, unknown>;
    if (typeof template.subject !== 'string' || template.subject.length === 0) {
      throw new ConfigValidationError(
        `auth.email_templates.${templateType}.subject`,
        'must be a non-empty string',
      );
    }
    if (typeof template.body_html !== 'string' || template.body_html.length === 0) {
      throw new ConfigValidationError(
        `auth.email_templates.${templateType}.body_html`,
        'must be a non-empty string',
      );
    }
    out[templateType] = {
      subject: template.subject,
      body_html: template.body_html,
    };
  }

  return out;
}

export function isEmailTemplateType(value: string): value is EmailTemplateType {
  return (EMAIL_TEMPLATE_TYPES as string[]).includes(value);
}
