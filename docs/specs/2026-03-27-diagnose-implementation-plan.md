# `insforge diagnose` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `insforge diagnose` command group that aggregates backend health data (EC2 metrics, advisor scans, DB diagnostics, logs) into a unified CLI experience.

**Architecture:** Flat subcommand structure under `diagnose`, each file calling `platformFetch` or `ossFetch` directly. Comprehensive report (`diagnose` with no subcommand) orchestrates all sources via `Promise.allSettled`. Follows existing CLI command patterns exactly.

**Tech Stack:** TypeScript, Commander.js, cli-table3, node fetch (via existing `platformFetch`/`ossFetch` wrappers)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/commands/diagnose/index.ts` | Register all diagnose subcommands + comprehensive report action |
| `src/commands/diagnose/metrics.ts` | `diagnose metrics` — fetch and display EC2 metrics |
| `src/commands/diagnose/advisor.ts` | `diagnose advisor` — fetch advisor scan summary + issues |
| `src/commands/diagnose/db.ts` | `diagnose db` — run predefined diagnostic SQL checks |
| `src/commands/diagnose/logs.ts` | `diagnose logs` — aggregate error-level log entries |
| `src/index.ts` | Register the `diagnose` command group (modify) |

---

### Task 1: Scaffold `diagnose metrics` subcommand

**Files:**
- Create: `src/commands/diagnose/metrics.ts`

- [ ] **Step 1: Create `src/commands/diagnose/metrics.ts`**

```typescript
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
  const avg = data.reduce((sum, d) => sum + d.value, 0) / data.length;
  const max = Math.max(...data.map((d) => d.value));
  return { latest, avg, max };
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
```

- [ ] **Step 2: Verify `platformFetch` is exported**

The `platformFetch` function in `src/lib/api/platform.ts` is currently not exported (it's a module-private function used by the public API functions). We need to export it.

Open `src/lib/api/platform.ts` and change:

```typescript
// Before:
async function platformFetch(

// After:
export async function platformFetch(
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/diagnose/metrics.ts src/lib/api/platform.ts
git commit -m "feat(diagnose): add metrics subcommand with EC2 metrics display"
```

---

### Task 2: Scaffold `diagnose advisor` subcommand

**Files:**
- Create: `src/commands/diagnose/advisor.ts`

- [ ] **Step 1: Create `src/commands/diagnose/advisor.ts`**

```typescript
import type { Command } from 'commander';
import { platformFetch } from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';


interface AdvisorScanSummary {
  scanId: string;
  status: string;
  scanType: string;
  scannedAt: string;
  summary: { total: number; critical: number; warning: number; info: number };
  collectorErrors: { collector: string; error: string; timestamp: string }[];
}

interface AdvisorIssue {
  id: string;
  ruleId: string;
  severity: string;
  category: string;
  title: string;
  description: string;
  affectedObject: string;
  recommendation: string;
  isResolved: boolean;
}

interface AdvisorIssuesResponse {
  issues: AdvisorIssue[];
  total: number;
}

export async function fetchAdvisorSummary(
  projectId: string,
  apiUrl?: string,
): Promise<AdvisorScanSummary> {
  const res = await platformFetch(`/projects/v1/${projectId}/advisor/latest`, {}, apiUrl);
  return (await res.json()) as AdvisorScanSummary;
}

export function registerDiagnoseAdvisorCommand(diagnoseCmd: Command): void {
  diagnoseCmd
    .command('advisor')
    .description('Display latest advisor scan results and issues')
    .option('--severity <level>', 'Filter by severity: critical, warning, info')
    .option('--category <cat>', 'Filter by category: security, performance, health')
    .option('--limit <n>', 'Maximum number of issues to return', '50')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();
        if (config.project_id === 'oss-project') {
          throw new CLIError(
            'Advisor requires InsForge Platform login. Not available when linked via --api-key.',
          );
        }

        const projectId = config.project_id;

        // Fetch scan summary
        const scanRes = await platformFetch(
          `/projects/v1/${projectId}/advisor/latest`,
          {},
          apiUrl,
        );
        const scan = (await scanRes.json()) as AdvisorScanSummary;

        // Fetch issues
        const issueParams = new URLSearchParams();
        if (opts.severity) issueParams.set('severity', opts.severity);
        if (opts.category) issueParams.set('category', opts.category);
        issueParams.set('limit', opts.limit);

        const issuesRes = await platformFetch(
          `/projects/v1/${projectId}/advisor/latest/issues?${issueParams.toString()}`,
          {},
          apiUrl,
        );
        const issuesData = (await issuesRes.json()) as AdvisorIssuesResponse;

        if (json) {
          outputJson({ scan, issues: issuesData.issues });
        } else {
          // Scan summary line
          const date = new Date(scan.scannedAt).toLocaleDateString();
          const s = scan.summary;
          console.log(
            `Scan: ${date} (${scan.status}) — ${s.critical} critical, ${s.warning} warning, ${s.info} info\n`,
          );

          if (!issuesData.issues || issuesData.issues.length === 0) {
            console.log('No issues found.');
            return;
          }

          const headers = ['Severity', 'Category', 'Affected Object', 'Title'];
          const rows = issuesData.issues.map((issue) => [
            issue.severity,
            issue.category,
            issue.affectedObject,
            issue.title,
          ]);
          outputTable(headers, rows);
        }
        await reportCliUsage('cli.diagnose.advisor', true);
      } catch (err) {
        await reportCliUsage('cli.diagnose.advisor', false);
        handleError(err, json);
      }
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/diagnose/advisor.ts
git commit -m "feat(diagnose): add advisor subcommand with scan summary and issues"
```

---

### Task 3: Scaffold `diagnose db` subcommand

**Files:**
- Create: `src/commands/diagnose/db.ts`

- [ ] **Step 1: Create `src/commands/diagnose/db.ts`**

```typescript
import type { Command } from 'commander';
import { runRawSql } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

interface DbCheck {
  label: string;
  sql: string;
  format: (rows: Record<string, unknown>[]) => void;
}

const DB_CHECKS: Record<string, DbCheck> = {
  connections: {
    label: 'Connections',
    sql: `SELECT
      (SELECT count(*) FROM pg_stat_activity WHERE state IS NOT NULL) AS active,
      (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max`,
    format(rows) {
      const r = rows[0] ?? {};
      console.log(`  Active: ${r.active} / ${r.max}`);
    },
  },
  'slow-queries': {
    label: 'Slow Queries (>5s)',
    sql: `SELECT pid, now() - query_start AS duration, substring(query for 80) AS query
      FROM pg_stat_activity
      WHERE state = 'active' AND now() - query_start > interval '5 seconds'
      ORDER BY query_start ASC`,
    format(rows) {
      if (rows.length === 0) {
        console.log('  None');
        return;
      }
      const headers = ['PID', 'Duration', 'Query'];
      const tableRows = rows.map((r) => [
        String(r.pid ?? ''),
        String(r.duration ?? ''),
        String(r.query ?? ''),
      ]);
      outputTable(headers, tableRows);
    },
  },
  bloat: {
    label: 'Table Bloat (top 10)',
    sql: `SELECT schemaname || '.' || relname AS table, n_dead_tup AS dead_tuples
      FROM pg_stat_user_tables
      ORDER BY n_dead_tup DESC
      LIMIT 10`,
    format(rows) {
      if (rows.length === 0) {
        console.log('  No user tables found.');
        return;
      }
      const headers = ['Table', 'Dead Tuples'];
      const tableRows = rows.map((r) => [
        String(r.table ?? ''),
        String(r.dead_tuples ?? 0),
      ]);
      outputTable(headers, tableRows);
    },
  },
  size: {
    label: 'Table Sizes (top 10)',
    sql: `SELECT schemaname || '.' || relname AS table,
        pg_size_pretty(pg_total_relation_size(relid)) AS size
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 10`,
    format(rows) {
      if (rows.length === 0) {
        console.log('  No user tables found.');
        return;
      }
      const headers = ['Table', 'Size'];
      const tableRows = rows.map((r) => [
        String(r.table ?? ''),
        String(r.size ?? ''),
      ]);
      outputTable(headers, tableRows);
    },
  },
  'index-usage': {
    label: 'Index Usage (worst 10)',
    sql: `SELECT relname AS table, idx_scan, seq_scan,
        CASE WHEN (idx_scan + seq_scan) > 0
          THEN round(100.0 * idx_scan / (idx_scan + seq_scan), 1)
          ELSE 0 END AS idx_ratio
      FROM pg_stat_user_tables
      WHERE (idx_scan + seq_scan) > 0
      ORDER BY idx_ratio ASC
      LIMIT 10`,
    format(rows) {
      if (rows.length === 0) {
        console.log('  No scan data available.');
        return;
      }
      const headers = ['Table', 'Index Scans', 'Seq Scans', 'Index Ratio'];
      const tableRows = rows.map((r) => [
        String(r.table ?? ''),
        String(r.idx_scan ?? 0),
        String(r.seq_scan ?? 0),
        `${r.idx_ratio ?? 0}%`,
      ]);
      outputTable(headers, tableRows);
    },
  },
  locks: {
    label: 'Waiting Locks',
    sql: `SELECT pid, mode, relation::regclass AS relation, granted
      FROM pg_locks
      WHERE NOT granted`,
    format(rows) {
      if (rows.length === 0) {
        console.log('  None');
        return;
      }
      const headers = ['PID', 'Mode', 'Relation', 'Granted'];
      const tableRows = rows.map((r) => [
        String(r.pid ?? ''),
        String(r.mode ?? ''),
        String(r.relation ?? ''),
        String(r.granted ?? ''),
      ]);
      outputTable(headers, tableRows);
    },
  },
  'cache-hit': {
    label: 'Cache Hit Ratio',
    sql: `SELECT CASE WHEN sum(heap_blks_hit + heap_blks_read) > 0
        THEN round(100.0 * sum(heap_blks_hit) / sum(heap_blks_hit + heap_blks_read), 1)
        ELSE 0 END AS ratio
      FROM pg_statio_user_tables`,
    format(rows) {
      const ratio = rows[0]?.ratio ?? 0;
      console.log(`  ${ratio}%`);
    },
  },
};

const ALL_CHECKS = Object.keys(DB_CHECKS);

export async function runDbChecks(): Promise<Record<string, Record<string, unknown>[]>> {
  const results: Record<string, Record<string, unknown>[]> = {};
  for (const key of ALL_CHECKS) {
    try {
      const { rows } = await runRawSql(DB_CHECKS[key].sql, true);
      results[key] = rows;
    } catch {
      results[key] = [];
    }
  }
  return results;
}

export function registerDiagnoseDbCommand(diagnoseCmd: Command): void {
  diagnoseCmd
    .command('db')
    .description('Run database health checks (connections, bloat, index usage, etc.)')
    .option('--check <checks>', 'Comma-separated checks: ' + ALL_CHECKS.join(', '), 'all')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const checkNames =
          opts.check === 'all'
            ? ALL_CHECKS
            : (opts.check as string).split(',').map((s: string) => s.trim());

        const results: Record<string, Record<string, unknown>[]> = {};

        for (const name of checkNames) {
          const check = DB_CHECKS[name];
          if (!check) {
            console.error(`Unknown check: ${name}. Available: ${ALL_CHECKS.join(', ')}`);
            continue;
          }
          try {
            const { rows } = await runRawSql(check.sql, true);
            results[name] = rows;
          } catch (err) {
            results[name] = [];
            if (!json) {
              console.error(`  Failed to run ${name}: ${err instanceof Error ? err.message : err}`);
            }
          }
        }

        if (json) {
          outputJson(results);
        } else {
          for (const name of checkNames) {
            const check = DB_CHECKS[name];
            if (!check) continue;
            console.log(`\n── ${check.label} ${'─'.repeat(Math.max(0, 40 - check.label.length))}`);
            check.format(results[name] ?? []);
          }
          console.log('');
        }
        await reportCliUsage('cli.diagnose.db', true);
      } catch (err) {
        await reportCliUsage('cli.diagnose.db', false);
        handleError(err, json);
      }
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/diagnose/db.ts
git commit -m "feat(diagnose): add db subcommand with predefined health checks"
```

---

### Task 4: Scaffold `diagnose logs` subcommand

**Files:**
- Create: `src/commands/diagnose/logs.ts`

- [ ] **Step 1: Create `src/commands/diagnose/logs.ts`**

```typescript
import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

const LOG_SOURCES = ['insforge.logs', 'postgREST.logs', 'postgres.logs', 'function.logs'] as const;

const ERROR_PATTERN = /\b(error|fatal|panic)\b/i;

interface LogEntry {
  timestamp: string;
  message: string;
  source: string;
}

interface SourceSummary {
  source: string;
  total: number;
  errors: LogEntry[];
}

function parseLogEntry(entry: unknown, source: string): { ts: string; msg: string } {
  if (typeof entry === 'string') {
    return { ts: '', msg: entry };
  }
  const e = entry as Record<string, unknown>;
  const ts = String(e.timestamp ?? e.time ?? '');
  const msg = String(e.message ?? e.msg ?? e.log ?? JSON.stringify(e));
  return { ts, msg };
}

async function fetchSourceLogs(source: string, limit: number): Promise<SourceSummary> {
  const res = await ossFetch(`/api/logs/${encodeURIComponent(source)}?limit=${limit}`);
  const data = await res.json();
  const logs = Array.isArray(data) ? data : ((data as Record<string, unknown>).logs as unknown[]) ?? [];

  const errors: LogEntry[] = [];
  for (const entry of logs) {
    const { ts, msg } = parseLogEntry(entry, source);
    if (ERROR_PATTERN.test(msg)) {
      errors.push({ timestamp: ts, message: msg, source });
    }
  }

  return { source, total: logs.length, errors };
}

export async function fetchLogsSummary(limit = 100): Promise<SourceSummary[]> {
  const results: SourceSummary[] = [];
  for (const source of LOG_SOURCES) {
    try {
      results.push(await fetchSourceLogs(source, limit));
    } catch {
      results.push({ source, total: 0, errors: [] });
    }
  }
  return results;
}

export function registerDiagnoseLogsCommand(diagnoseCmd: Command): void {
  diagnoseCmd
    .command('logs')
    .description('Aggregate error-level logs from all backend sources')
    .option('--source <name>', 'Specific log source to check')
    .option('--limit <n>', 'Number of log entries per source', '100')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const limit = parseInt(opts.limit, 10) || 100;
        const sources = opts.source ? [opts.source as string] : [...LOG_SOURCES];

        const summaries: SourceSummary[] = [];
        for (const source of sources) {
          try {
            summaries.push(await fetchSourceLogs(source, limit));
          } catch {
            summaries.push({ source, total: 0, errors: [] });
          }
        }

        if (json) {
          outputJson({ sources: summaries });
        } else {
          // Summary table
          const headers = ['Source', 'Total', 'Errors'];
          const rows = summaries.map((s) => [s.source, String(s.total), String(s.errors.length)]);
          outputTable(headers, rows);

          // Error details
          const allErrors = summaries.flatMap((s) => s.errors);
          if (allErrors.length > 0) {
            console.log('\n── Error Details ' + '─'.repeat(30));
            for (const err of allErrors) {
              const prefix = err.timestamp ? `[${err.source}] ${err.timestamp}` : `[${err.source}]`;
              console.log(`\n  ${prefix}`);
              console.log(`  ${err.message}`);
            }
            console.log('');
          }
        }
        await reportCliUsage('cli.diagnose.logs', true);
      } catch (err) {
        await reportCliUsage('cli.diagnose.logs', false);
        handleError(err, json);
      }
    });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/diagnose/logs.ts
git commit -m "feat(diagnose): add logs subcommand with error aggregation"
```

---

### Task 5: Scaffold `diagnose/index.ts` with comprehensive report and command registration

**Files:**
- Create: `src/commands/diagnose/index.ts`

- [ ] **Step 1: Create `src/commands/diagnose/index.ts`**

```typescript
import type { Command } from 'commander';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

import { fetchMetricsSummary, registerDiagnoseMetricsCommand } from './metrics.js';
import { fetchAdvisorSummary, registerDiagnoseAdvisorCommand } from './advisor.js';
import { runDbChecks, registerDiagnoseDbCommand } from './db.js';
import { fetchLogsSummary, registerDiagnoseLogsCommand } from './logs.js';

function sectionHeader(title: string): string {
  return `── ${title} ${'─'.repeat(Math.max(0, 44 - title.length))}`;
}

export function registerDiagnoseCommands(diagnoseCmd: Command): void {
  // Comprehensive report (no subcommand)
  diagnoseCmd
    .description('Backend diagnostics — run with no subcommand for a full health report')
    .action(async (_opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();

        const projectId = config.project_id;
        const projectName = config.project_name;
        const ossMode = config.project_id === 'oss-project';

        // In OSS mode (linked via --api-key), skip Platform API calls (metrics/advisor)
        const metricsPromise = ossMode
          ? Promise.reject(new Error('Platform login required (linked via --api-key)'))
          : fetchMetricsSummary(projectId, apiUrl);
        const advisorPromise = ossMode
          ? Promise.reject(new Error('Platform login required (linked via --api-key)'))
          : fetchAdvisorSummary(projectId, apiUrl);

        const [metricsResult, advisorResult, dbResult, logsResult] = await Promise.allSettled([
          metricsPromise,
          advisorPromise,
          runDbChecks(),
          fetchLogsSummary(100),
        ]);

        if (json) {
          const report: Record<string, unknown> = { project: projectName, errors: [] };
          const errors: string[] = [];

          if (metricsResult.status === 'fulfilled') {
            const data = metricsResult.value;
            report.metrics = data.metrics.map((m) => {
              if (m.data.length === 0) return { metric: m.metric, latest: null, avg: null, max: null };
              let sum = 0;
              let max = -Infinity;
              for (const d of m.data) {
                sum += d.value;
                if (d.value > max) max = d.value;
              }
              return {
                metric: m.metric,
                latest: m.data[m.data.length - 1].value,
                avg: sum / m.data.length,
                max,
              };
            });
          } else {
            report.metrics = null;
            errors.push(metricsResult.reason?.message ?? 'Metrics unavailable');
          }

          if (advisorResult.status === 'fulfilled') {
            report.advisor = advisorResult.value;
          } else {
            report.advisor = null;
            errors.push(advisorResult.reason?.message ?? 'Advisor unavailable');
          }

          if (dbResult.status === 'fulfilled') {
            report.db = dbResult.value;
          } else {
            report.db = null;
            errors.push(dbResult.reason?.message ?? 'DB checks unavailable');
          }

          if (logsResult.status === 'fulfilled') {
            report.logs = logsResult.value;
          } else {
            report.logs = null;
            errors.push(logsResult.reason?.message ?? 'Logs unavailable');
          }

          report.errors = errors;
          outputJson(report);
        } else {
          console.log(`\n  InsForge Health Report — ${projectName}\n`);

          // Metrics section
          console.log(sectionHeader('System Metrics (last 1h)'));
          if (metricsResult.status === 'fulfilled') {
            const metrics = metricsResult.value.metrics;
            if (metrics.length === 0) {
              console.log('  No metrics data available.');
            } else {
              const vals: Record<string, number> = {};
              for (const m of metrics) {
                if (m.data.length > 0) vals[m.metric] = m.data[m.data.length - 1].value;
              }
              const cpu = vals.cpu_usage !== undefined ? `${vals.cpu_usage.toFixed(1)}%` : 'N/A';
              const mem = vals.memory_usage !== undefined ? `${vals.memory_usage.toFixed(1)}%` : 'N/A';
              const disk = vals.disk_usage !== undefined ? `${vals.disk_usage.toFixed(1)}%` : 'N/A';
              const netIn = vals.network_in !== undefined ? formatBytesCompact(vals.network_in) + '/s' : 'N/A';
              const netOut = vals.network_out !== undefined ? formatBytesCompact(vals.network_out) + '/s' : 'N/A';
              console.log(`  CPU: ${cpu}   Memory: ${mem}`);
              console.log(`  Disk: ${disk}  Network: ↑${netIn} ↓${netOut}`);
            }
          } else {
            console.log(`  N/A — ${metricsResult.reason?.message ?? 'unavailable'}`);
          }

          // Advisor section
          console.log('\n' + sectionHeader('Advisor Scan'));
          if (advisorResult.status === 'fulfilled') {
            const scan = advisorResult.value;
            const s = scan.summary;
            const date = new Date(scan.scannedAt).toLocaleDateString();
            console.log(`  ${date} (${scan.status}) — ${s.critical} critical · ${s.warning} warning · ${s.info} info`);
          } else {
            console.log(`  N/A — ${advisorResult.reason?.message ?? 'unavailable'}`);
          }

          // DB section
          console.log('\n' + sectionHeader('Database'));
          if (dbResult.status === 'fulfilled') {
            const db = dbResult.value;
            const conn = db.connections?.[0] as Record<string, unknown> | undefined;
            const cache = db['cache-hit']?.[0] as Record<string, unknown> | undefined;
            const deadTuples = (db.bloat ?? []).reduce(
              (sum: number, r: Record<string, unknown>) => sum + (Number(r.dead_tuples) || 0),
              0,
            );
            const lockCount = (db.locks ?? []).length;

            console.log(
              `  Connections: ${conn?.active ?? '?'}/${conn?.max ?? '?'}  Cache Hit: ${cache?.ratio ?? '?'}%`,
            );
            console.log(
              `  Dead tuples: ${deadTuples.toLocaleString()}   Locks waiting: ${lockCount}`,
            );
          } else {
            console.log(`  N/A — ${dbResult.reason?.message ?? 'unavailable'}`);
          }

          // Logs section
          console.log('\n' + sectionHeader('Recent Errors (last 100 logs/source)'));
          if (logsResult.status === 'fulfilled') {
            const summaries = logsResult.value;
            const parts = summaries.map((s) => `${s.source}: ${s.errors.length}`);
            console.log(`  ${parts.join('  ')}`);
          } else {
            console.log(`  N/A — ${logsResult.reason?.message ?? 'unavailable'}`);
          }

          console.log('');
        }
        await reportCliUsage('cli.diagnose', true);
      } catch (err) {
        await reportCliUsage('cli.diagnose', false);
        handleError(err, json);
      }
    });

  // Register subcommands
  registerDiagnoseMetricsCommand(diagnoseCmd);
  registerDiagnoseAdvisorCommand(diagnoseCmd);
  registerDiagnoseDbCommand(diagnoseCmd);
  registerDiagnoseLogsCommand(diagnoseCmd);
}

function formatBytesCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/diagnose/index.ts
git commit -m "feat(diagnose): add comprehensive health report and command registration"
```

---

### Task 6: Register `diagnose` in the main CLI entry point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import to `src/index.ts`**

Add after the existing imports (e.g. after the `registerMetadataCommand` import):

```typescript
import { registerDiagnoseCommands } from './commands/diagnose/index.js';
```

- [ ] **Step 2: Register the diagnose command group**

Add after the `registerMetadataCommand(program);` line (around line 163):

```typescript
// Diagnose commands
const diagnoseCmd = program.command('diagnose');
registerDiagnoseCommands(diagnoseCmd);
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(diagnose): register diagnose command group in CLI entry point"
```

---

### Task 7: Build and manual smoke test

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: No TypeScript errors, clean build.

- [ ] **Step 2: Verify command registration**

Run: `node dist/index.js diagnose --help`
Expected: Shows `diagnose` description with subcommands `metrics`, `advisor`, `db`, `logs`.

- [ ] **Step 3: Test `--json` output structure**

Run: `node dist/index.js --json diagnose` (with a linked project)
Expected: JSON output with `metrics`, `advisor`, `db`, `logs`, and `errors` fields. Some may be `null` if services are unavailable.

- [ ] **Step 4: Test individual subcommands**

Run each:
```bash
node dist/index.js diagnose metrics --range 1h
node dist/index.js diagnose advisor
node dist/index.js diagnose db --check connections,cache-hit
node dist/index.js diagnose logs --limit 50
```
Expected: Table output for each. If a service is unavailable, should show an error message (not crash).

- [ ] **Step 5: Test `--json` mode for subcommands**

Run: `node dist/index.js --json diagnose db`
Expected: JSON object with keys for each check.

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(diagnose): address smoke test findings"
```
