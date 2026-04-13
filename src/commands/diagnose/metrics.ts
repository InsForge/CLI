import type { Command } from 'commander';
import { platformFetch } from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig, FAKE_PROJECT_ID } from '../../lib/config.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackDiagnose, shutdownAnalytics } from '../../lib/analytics.js';

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

/**
 * Aggregate multiple series of the same metric (e.g. multiple network interfaces)
 * into a single series per metric name. Network metrics are summed; others take the first series.
 */
function aggregateByMetric(series: MetricSeries[]): MetricSeries[] {
  const grouped = new Map<string, MetricSeries[]>();
  for (const s of series) {
    const existing = grouped.get(s.metric);
    if (existing) existing.push(s);
    else grouped.set(s.metric, [s]);
  }

  const result: MetricSeries[] = [];
  for (const [metric, group] of grouped) {
    if (group.length === 1 || !NETWORK_METRICS.has(metric)) {
      result.push(group[0]);
      continue;
    }
    // Sum network metrics across interfaces by matching timestamps
    const tsMap = new Map<number, number>();
    for (const s of group) {
      for (const d of s.data) {
        tsMap.set(d.timestamp, (tsMap.get(d.timestamp) ?? 0) + d.value);
      }
    }
    const merged: MetricDataPoint[] = [...tsMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([timestamp, value]) => ({ timestamp, value }));
    result.push({ metric, instance_id: 'aggregate', data: merged });
  }
  return result;
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
        await requireAuth(apiUrl);
        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();
        if (config.project_id === FAKE_PROJECT_ID) {
          throw new CLIError(
            'Metrics requires InsForge Platform login. Not available when linked via --api-key.',
          );
        }
        trackDiagnose('metrics', config);

        const params = new URLSearchParams({ range: opts.range });
        if (opts.metrics) params.set('metrics', opts.metrics);

        const res = await platformFetch(
          `/projects/v1/${config.project_id}/metrics?${params.toString()}`,
          {},
          apiUrl,
        );
        const data = (await res.json()) as MetricsResponse;

        const aggregated = aggregateByMetric(data.metrics);

        if (json) {
          const enriched = {
            ...data,
            metrics: aggregated.map((m) => {
              const stats = computeStats(m.data);
              return { ...m, latest: stats.latest, avg: stats.avg, max: stats.max };
            }),
          };
          outputJson(enriched);
        } else {
          if (!aggregated.length) {
            console.log('No metrics data available.');
            return;
          }
          const headers = ['Metric', 'Latest', 'Avg', 'Max', 'Range'];
          const rows = aggregated.map((m) => {
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
      } finally {
        await shutdownAnalytics();
      }
    });
}
