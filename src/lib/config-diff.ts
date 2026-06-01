import type {
  EmailTemplateConfig,
  EmailTemplateType,
  InsforgeConfig,
  PasswordConfig,
  RetentionConfig,
  StorageConfig,
  SmtpConfig,
  VerificationMethod,
} from './config-schema.js';
import { parseEnvRef } from './config-secrets.js';

/**
 * A single declarative change the file would impose on live state. Discriminated
 * union: each variant maps to one backend endpoint at apply time.
 *
 * The auth flags and every auth.password.* field all hit the SAME endpoint
 * (PUT /api/auth/config) but stay independent variants on purpose: each is
 * capability-gated and applied separately, so a partial write succeeds on
 * backends that only support a subset. Per-change PUTs are idempotent and
 * preserve "default-keep" semantics for unspecified fields.
 */
export type DiffChange =
  | {
      section: 'auth';
      op: 'modify';
      key: 'allowed_redirect_urls';
      from: string[];
      to: string[];
    }
  | {
      section: 'auth';
      op: 'modify';
      key: 'require_email_verification';
      from: boolean;
      to: boolean;
    }
  | {
      section: 'auth';
      op: 'modify';
      key: 'verify_email_method';
      from: VerificationMethod;
      to: VerificationMethod;
    }
  | {
      section: 'auth';
      op: 'modify';
      key: 'reset_password_method';
      from: VerificationMethod;
      to: VerificationMethod;
    }
  | {
      section: 'auth';
      op: 'modify';
      key: 'disable_signup';
      from: boolean;
      to: boolean;
    }
  | {
      section: 'auth.password';
      op: 'modify';
      key: 'min_length';
      from: number;
      to: number;
    }
  | {
      section: 'auth.password';
      op: 'modify';
      key: 'require_number' | 'require_lowercase' | 'require_uppercase' | 'require_special_char';
      from: boolean;
      to: boolean;
    }
  | {
      section: 'auth.smtp';
      op: 'modify';
      key: 'config';
      from: SmtpDiffView;
      to: SmtpDiffView;
      /**
       * env() reference name (e.g. "SMTP_PASSWORD") when the TOML's password
       * field is present. Carried separately from the rendered from/to so the
       * apply layer can resolve the secret at PUT time without re-parsing.
       * When set, the password is force-resent even if nothing else changed.
       */
      passwordEnvRef?: string;
    }
  | {
      section: 'auth.email_templates';
      op: 'modify';
      key: EmailTemplateType;
      from: EmailTemplateConfig;
      to: EmailTemplateConfig;
    }
  | {
      section: 'storage';
      op: 'modify';
      key: 'max_file_size_mb';
      from: number;
      to: number;
    }
  | {
      section: 'realtime' | 'schedules';
      op: 'modify';
      key: 'retention_days';
      from: number | null;
      to: number | null;
    }
  | {
      section: 'deployments';
      op: 'modify';
      key: 'subdomain';
      from: string | null;
      to: string | null;
    };

/**
 * Renderable view of SMTP state for plan/diff display. The `password` slot is
 * always an opaque marker — actual values never appear in plan output.
 */
export interface SmtpDiffView {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  /**
   * Opaque marker:
   *   "(set)"        — live state with hasPassword: true
   *   "(unset)"      — live state with hasPassword: false
   *   "env(NAME)"    — TOML side referencing a secret (force re-send)
   *   "(unchanged)"  — TOML side omitting the field (preserve)
   */
  password: string;
  sender_email: string;
  sender_name: string;
  min_interval_seconds: number;
}

/**
 * Live SMTP state pulled from /api/metadata auth.smtpConfig slice. The
 * backend never returns the actual password — `hasPassword` is the only
 * signal we get about credential presence.
 */
export interface LiveSmtpState {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  sender_email: string;
  sender_name: string;
  min_interval_seconds: number;
}

export interface DiffSummary {
  add: number;
  modify: number;
  remove: number;
  kept: number;
}

export interface DiffResult {
  changes: DiffChange[];
  summary: DiffSummary;
}

export interface DiffInput {
  live: LiveConfig;
  file: InsforgeConfig;
}

/**
 * Live state shape used as input to diff. Mirrors InsforgeConfig but the SMTP
 * slice includes hasPassword (which we get from the backend but never emit
 * back into TOML).
 */
export interface LiveConfig {
  auth?: {
    allowed_redirect_urls?: string[];
    require_email_verification?: boolean;
    verify_email_method?: VerificationMethod;
    reset_password_method?: VerificationMethod;
    disable_signup?: boolean;
    password?: LivePasswordPolicy;
    smtp?: LiveSmtpState;
    email_templates?: Partial<Record<EmailTemplateType, EmailTemplateConfig>>;
  };
  storage?: {
    max_file_size_mb?: number;
  };
  realtime?: {
    retention_days?: number | null;
  };
  schedules?: {
    retention_days?: number | null;
  };
  deployments?: {
    subdomain?: string | null;
  };
}

export interface LivePasswordPolicy {
  min_length: number;
  require_number: boolean;
  require_lowercase: boolean;
  require_uppercase: boolean;
  require_special_char: boolean;
}

/**
 * Compute the changes the file would impose on the live state.
 * Default-keep semantics: if the file omits a section, live state is
 * untouched. Each section diffs independently.
 */
export function diffConfig({ live, file }: DiffInput): DiffResult {
  const changes: DiffChange[] = [];

  const fileAuth = file.auth;
  const liveAuth = live.auth ?? {};

  if (fileAuth && 'allowed_redirect_urls' in fileAuth) {
    // Treat the redirect allowlist as a set: order and duplicates in the TOML
    // shouldn't produce a diff. Reorder/dedupe both sides before comparing.
    const fromV = normalizeUrlList(liveAuth.allowed_redirect_urls);
    const toV = normalizeUrlList(fileAuth.allowed_redirect_urls);
    if (!arrayEquals(fromV, toV)) {
      changes.push({
        section: 'auth',
        op: 'modify',
        key: 'allowed_redirect_urls',
        from: fromV,
        to: toV,
      });
    }
  }

  if (fileAuth && 'require_email_verification' in fileAuth) {
    const fromV = liveAuth.require_email_verification ?? false;
    const toV = fileAuth.require_email_verification ?? false;
    if (fromV !== toV) {
      changes.push({
        section: 'auth',
        op: 'modify',
        key: 'require_email_verification',
        from: fromV,
        to: toV,
      });
    }
  }

  // Match the `'key' in fileAuth` pattern used for require_email_verification.
  // Truthy checks happen to work today (both enum values are truthy) but would
  // silently misbehave if a future VerificationMethod value (e.g. literal "0")
  // were added.
  if (fileAuth && 'verify_email_method' in fileAuth && fileAuth.verify_email_method) {
    // 'code' matches the backend default for an unset live row; treating
    // absent live as 'code' avoids a spurious diff on fresh projects.
    const fromV: VerificationMethod = liveAuth.verify_email_method ?? 'code';
    const toV = fileAuth.verify_email_method;
    if (fromV !== toV) {
      changes.push({
        section: 'auth',
        op: 'modify',
        key: 'verify_email_method',
        from: fromV,
        to: toV,
      });
    }
  }

  if (fileAuth && 'reset_password_method' in fileAuth && fileAuth.reset_password_method) {
    const fromV: VerificationMethod = liveAuth.reset_password_method ?? 'code';
    const toV = fileAuth.reset_password_method;
    if (fromV !== toV) {
      changes.push({
        section: 'auth',
        op: 'modify',
        key: 'reset_password_method',
        from: fromV,
        to: toV,
      });
    }
  }

  if (fileAuth && 'disable_signup' in fileAuth) {
    const fromV = liveAuth.disable_signup ?? false;
    const toV = fileAuth.disable_signup ?? false;
    if (fromV !== toV) {
      changes.push({
        section: 'auth',
        op: 'modify',
        key: 'disable_signup',
        from: fromV,
        to: toV,
      });
    }
  }

  if (fileAuth?.password) {
    diffPassword(liveAuth.password, fileAuth.password, changes);
  }

  if (fileAuth?.smtp !== undefined) {
    const smtpChange = diffSmtp(liveAuth.smtp, fileAuth.smtp);
    if (smtpChange) changes.push(smtpChange);
  }

  if (fileAuth?.email_templates !== undefined) {
    diffEmailTemplates(liveAuth.email_templates, fileAuth.email_templates, changes);
  }

  if (file.storage !== undefined) {
    diffStorage(live.storage, file.storage, changes);
  }

  if (file.realtime !== undefined) {
    diffRetention('realtime', live.realtime, file.realtime, changes);
  }

  if (file.schedules !== undefined) {
    diffRetention('schedules', live.schedules, file.schedules, changes);
  }

  const fileDeployments = file.deployments;
  const liveDeployments = live.deployments ?? {};
  if (fileDeployments && 'subdomain' in fileDeployments) {
    const fromV = liveDeployments.subdomain ?? null;
    // Empty-string in TOML means "clear the slug" — TOML has no null literal,
    // so this is the only way the user can express "unset" without deleting
    // the line. The PUT body sends slug: null which the backend interprets
    // as clear.
    const rawTo = fileDeployments.subdomain;
    // `subdomain?: string | null` widens to include undefined under exactOptionalPropertyTypes.
    // Treat absent / null / empty-string all as "clear".
    const toV: string | null =
      rawTo === null || rawTo === undefined || rawTo === '' ? null : rawTo;
    if (fromV !== toV) {
      changes.push({
        section: 'deployments',
        op: 'modify',
        key: 'subdomain',
        from: fromV,
        to: toV,
      });
    }
  }

  return { changes, summary: summarize(changes) };
}

/**
 * Per-key diff of the password policy. Unlike SMTP this is NOT whole-object:
 * a partial [auth.password] block in TOML applies only the fields it names,
 * preserving the rest of live state. Mirrors the existing per-key pattern of
 * allowed_redirect_urls / require_email_verification.
 *
 * Empty-live (legacy backend that doesn't expose the policy) falls back to
 * the documented backend defaults so the diff still shows the user what the
 * file would impose.
 */
function diffPassword(
  live: LivePasswordPolicy | undefined,
  file: PasswordConfig,
  changes: DiffChange[],
): void {
  const liveView = live ?? EMPTY_PASSWORD_POLICY;

  if (file.min_length !== undefined && liveView.min_length !== file.min_length) {
    changes.push({
      section: 'auth.password',
      op: 'modify',
      key: 'min_length',
      from: liveView.min_length,
      to: file.min_length,
    });
  }
  for (const key of [
    'require_number',
    'require_lowercase',
    'require_uppercase',
    'require_special_char',
  ] as const) {
    const fromV = liveView[key];
    const toV = file[key];
    if (toV !== undefined && fromV !== toV) {
      changes.push({
        section: 'auth.password',
        op: 'modify',
        key,
        from: fromV,
        to: toV,
      });
    }
  }
}

function diffEmailTemplates(
  live: Partial<Record<EmailTemplateType, EmailTemplateConfig>> | undefined,
  file: Partial<Record<EmailTemplateType, EmailTemplateConfig>>,
  changes: DiffChange[],
): void {
  for (const [templateType, toV] of Object.entries(file) as Array<
    [EmailTemplateType, EmailTemplateConfig | undefined]
  >) {
    if (!toV) continue;
    const fromV = live?.[templateType] ?? EMPTY_EMAIL_TEMPLATE;
    if (fromV.subject !== toV.subject || fromV.body_html !== toV.body_html) {
      changes.push({
        section: 'auth.email_templates',
        op: 'modify',
        key: templateType,
        from: fromV,
        to: toV,
      });
    }
  }
}

function diffStorage(
  live: LiveConfig['storage'] | undefined,
  file: StorageConfig,
  changes: DiffChange[],
): void {
  if (file.max_file_size_mb === undefined) return;
  const fromV = live?.max_file_size_mb ?? EMPTY_STORAGE_CONFIG.max_file_size_mb;
  if (fromV !== file.max_file_size_mb) {
    changes.push({
      section: 'storage',
      op: 'modify',
      key: 'max_file_size_mb',
      from: fromV,
      to: file.max_file_size_mb,
    });
  }
}

function diffRetention(
  section: 'realtime' | 'schedules',
  live: LiveConfig['realtime'] | LiveConfig['schedules'] | undefined,
  file: RetentionConfig,
  changes: DiffChange[],
): void {
  if (!('retention_days' in file)) return;
  const fromV = normalizeRetentionDays(live?.retention_days);
  const toV = normalizeRetentionDays(file.retention_days);
  if (fromV !== toV) {
    changes.push({
      section,
      op: 'modify',
      key: 'retention_days',
      from: fromV,
      to: toV,
    });
  }
}

function normalizeRetentionDays(value: number | null | undefined): number | null {
  // TOML has no null literal. Use retention_days = 0 as the explicit
  // "disable cleanup" spelling and translate it to the backend's null.
  return value === undefined || value === null || value === 0 ? null : value;
}

/**
 * Diff a single SMTP section. Whole-object semantics: any field difference
 * (including a force-resend of the password) emits one change targeting the
 * upsert endpoint. Returns null if the TOML matches live state and no
 * password env ref is present (the only no-op case).
 */
function diffSmtp(
  live: LiveSmtpState | undefined,
  fileSmtp: SmtpConfig,
): DiffChange | null {
  const livedView = renderLiveSmtp(live);
  const tomlView = renderFileSmtp(fileSmtp);
  const envRef = fileSmtp.password ? parseEnvRef(fileSmtp.password) : null;

  const nonPasswordFieldsChanged =
    livedView.enabled !== tomlView.enabled ||
    livedView.host !== tomlView.host ||
    livedView.port !== tomlView.port ||
    livedView.username !== tomlView.username ||
    livedView.sender_email !== tomlView.sender_email ||
    livedView.sender_name !== tomlView.sender_name ||
    livedView.min_interval_seconds !== tomlView.min_interval_seconds;

  // Force-resend semantics: if the TOML carries a password env() ref,
  // we always re-send it (we can't tell whether the secrets-store value
  // changed without resolving + comparing, which would expose the value
  // through the diff). Re-sending is safer if the user rotated the secret
  // but forgot to re-apply.
  if (!nonPasswordFieldsChanged && envRef === null) {
    return null;
  }

  return {
    section: 'auth.smtp',
    op: 'modify',
    key: 'config',
    from: livedView,
    to: tomlView,
    passwordEnvRef: envRef ?? undefined,
  };
}

/**
 * Map live backend state to the diff view. Password slot reflects only
 * hasPassword — the actual value is never available client-side.
 */
function renderLiveSmtp(live: LiveSmtpState | undefined): SmtpDiffView {
  const empty = EMPTY_SMTP_VIEW;
  if (!live) return empty;
  return {
    enabled: live.enabled,
    host: live.host,
    port: live.port,
    username: live.username,
    password: live.hasPassword ? '(set)' : '(unset)',
    sender_email: live.sender_email,
    sender_name: live.sender_name,
    min_interval_seconds: live.min_interval_seconds,
  };
}

/**
 * Map TOML file state to the diff view. Missing fields fall back to the
 * empty-config shape — the backend's upsert handles partials with its own
 * defaults, so we render what the file says (not aspirational defaults).
 */
function renderFileSmtp(file: SmtpConfig): SmtpDiffView {
  return {
    enabled: file.enabled ?? false,
    host: file.host ?? '',
    port: file.port ?? 587,
    username: file.username ?? '',
    password: renderFilePassword(file.password),
    sender_email: file.sender_email ?? '',
    sender_name: file.sender_name ?? '',
    min_interval_seconds: file.min_interval_seconds ?? 60,
  };
}

function renderFilePassword(value: string | undefined): string {
  if (value === undefined) return '(unchanged)';
  const ref = parseEnvRef(value);
  // Validator already rejected literals; if ref is null here something
  // upstream is broken. Fall back to opaque marker.
  return ref ? `env(${ref})` : '(invalid)';
}

const EMPTY_SMTP_VIEW: SmtpDiffView = {
  enabled: false,
  host: '',
  port: 587,
  username: '',
  password: '(unset)',
  sender_email: '',
  sender_name: '',
  min_interval_seconds: 60,
};

const EMPTY_EMAIL_TEMPLATE: EmailTemplateConfig = {
  subject: '',
  body_html: '',
};

const EMPTY_STORAGE_CONFIG = {
  max_file_size_mb: 50,
};

// Backend defaults for auth.password fields when the live row is missing
// (legacy backend or fresh project). Mirrors `authConfigSchema` defaults in
// shared-schemas: any drift here will surface as a spurious diff on first
// apply against an older backend.
const EMPTY_PASSWORD_POLICY: LivePasswordPolicy = {
  min_length: 8,
  require_number: false,
  require_lowercase: false,
  require_uppercase: false,
  require_special_char: false,
};

function summarize(changes: DiffChange[]): DiffSummary {
  const s: DiffSummary = { add: 0, modify: 0, remove: 0, kept: 0 };
  for (const c of changes) {
    if (c.op === 'modify') s.modify++;
  }
  return s;
}

function normalizeUrlList(input: string[] | undefined): string[] {
  return Array.from(new Set(input ?? [])).sort();
}

function arrayEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
