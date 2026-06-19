import { PostHog } from 'posthog-node';
import type { ProjectConfig } from '../types.js';
import { FAKE_PROJECT_ID } from './config.js';

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!POSTHOG_API_KEY) return null;
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST });
  }
  return client;
}

export function captureEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    getClient()?.capture({ distinctId, event, properties });
  } catch {
    // analytics should never break the CLI
  }
}

export function trackCommand(command: string, distinctId: string, properties?: Record<string, unknown>): void {
  captureEvent(distinctId, 'cli_command_invoked', {
    command,
    ...properties,
  });
}

export function trackDiagnose(subcommand: string, config: ProjectConfig): void {
  captureEvent(config.project_id, 'cli_diagnose_invoked', {
    subcommand,
    project_id: config.project_id,
    project_name: config.project_name,
    org_id: config.org_id,
    region: config.region,
    oss_mode: config.project_id === FAKE_PROJECT_ID,
  });
}

export function trackPayments(
  subcommand: string,
  config: ProjectConfig,
  properties?: Record<string, unknown>,
): void {
  captureEvent(config.project_id, 'cli_payments_invoked', {
    subcommand,
    project_id: config.project_id,
    project_name: config.project_name,
    org_id: config.org_id,
    region: config.region,
    oss_mode: config.project_id === FAKE_PROJECT_ID,
    ...properties,
  });
}

export function trackDeployments(
  subcommand: string,
  config: ProjectConfig,
  properties?: Record<string, unknown>,
): void {
  captureEvent(config.project_id, 'cli_deployments_invoked', {
    subcommand,
    project_id: config.project_id,
    project_name: config.project_name,
    org_id: config.org_id,
    region: config.region,
    oss_mode: config.project_id === FAKE_PROJECT_ID,
    ...properties,
  });
}

// Step 2 of the "dashboard connect → CLI posthog setup" funnel; pair with
// backend `posthog_connect_started` joined on project_id.
export function trackPosthog(
  subcommand: string,
  config: ProjectConfig,
  properties?: Record<string, unknown>,
): void {
  captureEvent(config.project_id, 'cli_posthog_invoked', {
    subcommand,
    project_id: config.project_id,
    project_name: config.project_name,
    org_id: config.org_id,
    region: config.region,
    oss_mode: config.project_id === FAKE_PROJECT_ID,
    ...properties,
  });
}

// Config commands (apply/plan/export) operate against an OSS backend and may
// run without a linked cloud project, so the ProjectConfig is optional.
// Pure-OSS runs fall back to FAKE_PROJECT_ID as the distinct ID — same
// convention `create`/`link` use when no project context exists yet.
export function trackConfig(
  subcommand: string,
  config: ProjectConfig | null,
  properties?: Record<string, unknown>,
): void {
  const distinctId = config?.project_id ?? FAKE_PROJECT_ID;
  captureEvent(distinctId, 'cli_config_invoked', {
    subcommand,
    project_id: config?.project_id,
    project_name: config?.project_name,
    org_id: config?.org_id,
    region: config?.region,
    oss_mode: !config || config.project_id === FAKE_PROJECT_ID,
    ...properties,
  });
}

export async function shutdownAnalytics(): Promise<void> {
  if (!client) return;
  const c = client;
  // Null the reference first so concurrent/duplicate calls (e.g. catch path
  // + finally) don't double-shutdown.
  client = null;
  try {
    await c.shutdown();
  } catch {
    // ignore
  }
}

export interface VerifyFinding {
  type: string;
  table?: string;
  kind?: string;
  status?: number;
  endpoint?: string;
  message?: string;
  evidence?: Record<string, unknown>;
}

/**
 * Emit a verify finding to PostHog — the central, cross-user rail (finding rate + what
 * broke), same as the other track* helpers here. NOT the per-project `oss_host/api/usage/mcp`
 * table, which only stores `(tool_name, success)` and drops the finding. The recording lives
 * in the tool — a finding is recorded because the probe ran, not because the agent remembered
 * to. Best-effort; the caller flushes via `shutdownAnalytics()` before exit.
 */
// Only structured, non-free-text fields reach PostHog (DEVELOPMENT.md telemetry guidance:
// never send user-entered free text). The agent-supplied `endpoint`/`message` are dropped
// entirely — even sanitized, they can leak params/emails/tokens. The PII-bearing evidence
// keys (`db_actual`/`ui_claimed`, the raw DB value the UI claimed) are filtered out too; RLS
// evidence (row counts) is not sensitive and stays. `endpoint`/`message` remain on the local
// `--json` finding for the caller — they're just never transmitted.
const SENSITIVE_EVIDENCE_KEYS = new Set(['db_actual', 'ui_claimed']);

export function trackVerifyFinding(finding: VerifyFinding, config: ProjectConfig): void {
  const safeEvidence = Object.fromEntries(
    Object.entries(finding.evidence ?? {}).filter(([k]) => !SENSITIVE_EVIDENCE_KEYS.has(k)),
  );
  captureEvent(config.project_id, 'cli_verify_finding', {
    ...safeEvidence,
    finding_type: finding.type,
    passed: finding.type === 'none',
    table: finding.table,
    kind: finding.kind,
    status: finding.status,
    project_id: config.project_id,
    project_name: config.project_name,
    org_id: config.org_id,
    region: config.region,
    oss_mode: config.project_id === FAKE_PROJECT_ID,
  });
}
