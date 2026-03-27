import type { Command } from 'commander';
import { platformFetch } from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

interface MetricDataPoint {
  timestamp: number;
  value: number;
}

interface MetricSeries {
  metric: string;
  instance_id: string;
  data: MetricDataPoint[];
}

interface MetricsResponse {
  project_id: string;
  range: string;
  metrics: MetricSeries[];
  _meta?: { requested_at: string; query_time_ms: number; cached: boolean };
}

const METRIC_LABELS: Record<string, string> = {
  cpu_usage: 'CPU Usage',
  memory_usage: 'Memory Usage',
  disk_usage: 'Disk Usage',
  network_in: 'Network In',
  network_out: 'Network Out',
};

const NETWORK_METRICS = new Set(['network_in', 'network_out']);

function formatValue(metric: string, value: number): string {
  if (NETWORK_METRICS.has(metric)) {
    return formatBytes(value) + '/s';
  }
  return `${value.toFixed(1)}%`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(1)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function computeStats(data: MetricDataPoint[]): { latest: number; avg: number; max: number } {
  if (data.length === 0) return { latest: 0, avg: 0, max: 0 };
  const latest = data[data.length - 1].value;
  let sum = 0;
  let max = -Infinity;
  for (const d of data) {
    sum += d.value;
    if (d.value > max) max = d.value;
  }
  return { latest, avg: sum / data.length, max };
}

export async function fetchMetricsSummary(
  projectId: string,
  apiUrl?: string,
): Promise<MetricsResponse> {
  const res = await platformFetch(`/projects/v1/${projectId}/metrics?range=1h`, {}, apiUrl);
  return (await res.json()) as MetricsResponse;
}

export function registerDiagnoseMetricsCommand(diagnoseCmd: Command): void {
  diagnoseCmd
    .command('metrics')
    .description('Display EC2 instance metrics (CPU, memory, disk, network)')
    .option('--range <range>', 'Time range: 1h, 6h, 24h, 7d', '1h')
    .option('--metrics <list>', 'Comma-separated metrics to query')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth();
        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();
        if (config.project_id === 'oss-project') {
          throw new CLIError(
            'Metrics requires InsForge Platform login. Not available when linked via --api-key.',
          );
        }

        const params = new URLSearchParams({ range: opts.range });
        if (opts.metrics) params.set('metrics', opts.metrics);

        const res = await platformFetch(
          `/projects/v1/${config.project_id}/metrics?${params.toString()}`,
          {},
          apiUrl,
        );
        const data = (await res.json()) as MetricsResponse;

        if (json) {
          const enriched = {
            ...data,
            metrics: data.metrics.map((m) => {
              const stats = computeStats(m.data);
              return { ...m, latest: stats.latest, avg: stats.avg, max: stats.max };
            }),
          };
          outputJson(enriched);
        } else {
          if (!data.metrics || data.metrics.length === 0) {
            console.log('No metrics data available.');
            return;
          }
          const headers = ['Metric', 'Latest', 'Avg', 'Max', 'Range'];
          const rows = data.metrics.map((m) => {
            const stats = computeStats(m.data);
            return [
              METRIC_LABELS[m.metric] ?? m.metric,
              formatValue(m.metric, stats.latest),
              formatValue(m.metric, stats.avg),
              formatValue(m.metric, stats.max),
              data.range,
            ];
          });
          outputTable(headers, rows);
        }
        await reportCliUsage('cli.diagnose.metrics', true);
      } catch (err) {
        await reportCliUsage('cli.diagnose.metrics', false);
        handleError(err, json);
      }
    });
}
