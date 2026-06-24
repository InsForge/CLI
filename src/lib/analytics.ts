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

// Generic per-group command telemetry. Emits `cli_<group>_invoked` with a
// `subcommand` property — the same event shape as the bespoke
// trackPayments/trackDeployments/... helpers, but without a hand-written
// function per group. Use this for command groups that don't already have a
// dedicated helper. `config` is optional: commands may run before a project is
// linked (e.g. OSS-only flows), in which case we fall back to FAKE_PROJECT_ID
// as the distinct ID, matching the convention in trackConfig/trackDomains.
export function trackGroupCommand(
  group: string,
  subcommand: string,
  config: ProjectConfig | null,
  properties?: Record<string, unknown>,
): void {
  const distinctId = config?.project_id ?? FAKE_PROJECT_ID;
  captureEvent(distinctId, `cli_${group}_invoked`, {
    subcommand,
    project_id: config?.project_id,
    project_name: config?.project_name,
    org_id: config?.org_id,
    region: config?.region,
    oss_mode: !config || config.project_id === FAKE_PROJECT_ID,
    ...properties,
  });
}

// Top-level standalone commands (login, whoami, list, ...) that don't belong
// to a group. Emits the shared `cli_command_invoked` event with a `command`
// property, matching the convention `create`/`link` already use via
// trackCommand, but additionally attaches project context when available.
export function trackTopLevelCommand(
  command: string,
  config: ProjectConfig | null,
  properties?: Record<string, unknown>,
): void {
  const distinctId = config?.project_id ?? FAKE_PROJECT_ID;
  captureEvent(distinctId, 'cli_command_invoked', {
    command,
    project_id: config?.project_id,
    project_name: config?.project_name,
    org_id: config?.org_id,
    region: config?.region,
    oss_mode: !config || config.project_id === FAKE_PROJECT_ID,
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

export function trackDomains(
  subcommand: string,
  config: ProjectConfig | null,
  properties?: Record<string, unknown>,
): void {
  const distinctId = config?.project_id ?? FAKE_PROJECT_ID;
  captureEvent(distinctId, 'cli_domains_invoked', {
    subcommand,
    project_id: config?.project_id,
    project_name: config?.project_name,
    org_id: config?.org_id,
    region: config?.region,
    oss_mode: !config || config.project_id === FAKE_PROJECT_ID,
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
