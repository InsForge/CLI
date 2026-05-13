import type { InsforgeConfig, SmtpConfig } from './config-schema.js';
import { parseEnvRef } from './config-secrets.js';

/**
 * A single declarative change the file would impose on live state. Discriminated
 * union: each variant maps to one backend endpoint at apply time.
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
    smtp?: LiveSmtpState;
  };
  deployments?: {
    subdomain?: string | null;
  };
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

  if (fileAuth?.smtp !== undefined) {
    const smtpChange = diffSmtp(liveAuth.smtp, fileAuth.smtp);
    if (smtpChange) changes.push(smtpChange);
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
    const toV = rawTo === null || rawTo === '' ? null : rawTo;
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
