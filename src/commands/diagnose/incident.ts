import type { Command } from 'commander';
import { platformFetch } from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig, FAKE_PROJECT_ID } from '../../lib/config.js';
import { outputJson } from '../../lib/output.js';
import { trackDiagnose, shutdownAnalytics } from '../../lib/analytics.js';

// Cloud-side incident report. Everything behind this endpoint lives on the
// platform (Prometheus history, platform records, an outbound DB probe), so
// the command keeps answering "why is my project 504ing / down?" even while
// the instance itself is unreachable — exactly when `diagnose logs` dies.

interface IncidentReport {
  project_id: string;
  project_status: string;
  operation_status: string | null;
  instance_type: string | null;
  reachable: {
    metrics_last_seen_at: string | null;
    metrics_reporting: boolean;
    database_connect: boolean;
  };
  down_since: string | null;
  memory_before_down_pct: number | null;
  memory_latest_pct: number | null;
  postgres_started_at: string | null;
  scrape_gaps_24h: number;
  recent_platform_operations: Array<{ action: string; at: string }>;
  verdict: string;
  explanation: string;
  recommendation: string;
}

const VERDICT_LABELS: Record<string, string> = {
  paused_or_suspended: 'Project is paused or suspended',
  platform_operation_in_progress: 'Platform operation in progress',
  oom_likely: 'Out of memory (likely)',
  down_unknown: 'Instance down, cause unclear',
  metrics_stopped: 'Instance stopped reporting metrics',
  no_incident_detected: 'No incident detected',
};

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Coerce whatever the platform returned into a report the renderer can
 * safely consume. This command exists precisely for moments when the
 * backend or instance state is unusual, so every field gets a defensive
 * default instead of trusting the cast. Throws a CLIError only when the
 * payload is not a report at all. Exported for tests.
 */
export function normalizeIncidentReport(raw: unknown): IncidentReport {
  if (raw === null || typeof raw !== 'object') {
    throw new CLIError(
      'Unexpected response from the platform (not an incident report). Your backend may predate this command.',
    );
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.verdict !== 'string' || typeof r.explanation !== 'string') {
    throw new CLIError(
      'Unexpected response from the platform (missing incident report fields). Your backend may predate this command.',
    );
  }
  const reachable =
    r.reachable !== null && typeof r.reachable === 'object'
      ? (r.reachable as Record<string, unknown>)
      : {};
  const operations = Array.isArray(r.recent_platform_operations)
    ? r.recent_platform_operations
    : [];
  return {
    project_id: asString(r.project_id, 'unknown'),
    project_status: asString(r.project_status, 'unknown'),
    operation_status: asNullableString(r.operation_status),
    instance_type: asNullableString(r.instance_type),
    reachable: {
      metrics_last_seen_at: asNullableString(reachable.metrics_last_seen_at),
      metrics_reporting: reachable.metrics_reporting === true,
      database_connect: reachable.database_connect === true,
    },
    down_since: asNullableString(r.down_since),
    memory_before_down_pct: asNullableNumber(r.memory_before_down_pct),
    memory_latest_pct: asNullableNumber(r.memory_latest_pct),
    postgres_started_at: asNullableString(r.postgres_started_at),
    scrape_gaps_24h: asNullableNumber(r.scrape_gaps_24h) ?? 0,
    recent_platform_operations: operations
      .filter(
        (op): op is { action: string; at: string } =>
          op !== null &&
          typeof op === 'object' &&
          typeof (op as Record<string, unknown>).action === 'string' &&
          typeof (op as Record<string, unknown>).at === 'string',
      )
      .map((op) => ({ action: op.action, at: op.at })),
    verdict: r.verdict,
    explanation: r.explanation,
    recommendation: asString(r.recommendation, ''),
  };
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleString();
}

/**
 * Render the report as printable lines. Pure and exported for tests — this
 * is the command's output contract. Every evidence field the backend sends
 * shows up here so the verdict is always accompanied by the facts behind it.
 */
export function formatIncidentReport(report: IncidentReport): string[] {
  const lines: string[] = [];
  lines.push(`Verdict: ${VERDICT_LABELS[report.verdict] ?? report.verdict}`);
  lines.push('');
  lines.push(report.explanation);
  lines.push('');
  const facts: string[] = [];
  if (report.project_status !== 'active') {
    facts.push(`Project status: ${report.project_status}`);
  }
  if (report.operation_status) {
    facts.push(`Platform operation in progress: ${report.operation_status}`);
  }
  facts.push(
    `Instance metrics: ${
      report.reachable.metrics_reporting
        ? 'reporting'
        : `not reporting (last seen ${formatWhen(report.reachable.metrics_last_seen_at)})`
    }`,
  );
  facts.push(
    `Database connection: ${report.reachable.database_connect ? 'accepting connections' : 'unreachable'}`,
  );
  if (report.down_since) {
    facts.push(`Down since: ${formatWhen(report.down_since)}`);
  }
  if (report.memory_before_down_pct !== null) {
    facts.push(`Memory right before: ${report.memory_before_down_pct}%`);
  } else if (report.memory_latest_pct !== null) {
    facts.push(`Memory latest: ${report.memory_latest_pct}%`);
  }
  if (report.postgres_started_at) {
    facts.push(`Postgres started: ${formatWhen(report.postgres_started_at)}`);
  }
  if (report.scrape_gaps_24h > 0) {
    facts.push(`Reporting gaps in the last 24h: ${report.scrape_gaps_24h}`);
  }
  if (report.instance_type) {
    facts.push(`Instance type: ${report.instance_type}`);
  }
  for (const op of report.recent_platform_operations) {
    facts.push(`Recent platform operation: ${op.action} at ${formatWhen(op.at)}`);
  }
  for (const fact of facts) {
    lines.push(`  - ${fact}`);
  }
  lines.push('');
  lines.push(`What to do: ${report.recommendation}`);
  return lines;
}

export function registerDiagnoseIncidentCommand(diagnoseCmd: Command): void {
  diagnoseCmd
    .command('incident')
    .description(
      'Explain why the project is down or returning gateway timeouts (504) — works even while the instance is unreachable',
    )
    .action(async (_opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();
        if (config.project_id === FAKE_PROJECT_ID) {
          throw new CLIError(
            'Incident report requires InsForge Platform login. Not available when linked via --api-key.',
          );
        }
        trackDiagnose('incident', config);

        const res = await platformFetch(
          `/projects/v1/${config.project_id}/diagnose/incident`,
          {},
          apiUrl,
        );
        const raw = await res.json();

        if (json) {
          // Raw passthrough: machine consumers get the exact server payload,
          // including fields this CLI version does not know about yet.
          outputJson(raw);
        } else {
          const report = normalizeIncidentReport(raw);
          for (const line of formatIncidentReport(report)) {
            console.log(line);
          }
        }
      } catch (err) {
        await shutdownAnalytics();
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
