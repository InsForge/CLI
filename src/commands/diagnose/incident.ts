import type { Command } from 'commander';
import { platformFetch } from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig, FAKE_PROJECT_ID } from '../../lib/config.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
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
  no_incident_detected: 'No incident detected',
};

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
        const report = (await res.json()) as IncidentReport;
        if (!report || typeof report !== 'object' || typeof report.reachable !== 'object') {
          throw new CLIError(
            'Unexpected response from the platform (missing incident report fields). Your backend may predate this command.',
          );
        }

        if (json) {
          outputJson(report);
        } else {
          for (const line of formatIncidentReport(report)) {
            console.log(line);
          }
        }
        await reportCliUsage('cli.diagnose.incident', true);
      } catch (err) {
        await reportCliUsage('cli.diagnose.incident', false);
        await shutdownAnalytics();
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
