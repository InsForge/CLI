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
  try {
    if (client) await client.shutdown();
  } catch {
    // ignore
  }
}
