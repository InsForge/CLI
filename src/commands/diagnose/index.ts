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
        await requireAuth();
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
