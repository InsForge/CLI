import type { Command } from 'commander';
import * as os from 'node:os';
import * as clack from '@clack/prompts';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackDiagnose, shutdownAnalytics } from '../../lib/analytics.js';
import { streamDiagnosticAnalysis, rateDiagnosticSession } from '../../lib/api/platform.js';

import { fetchMetricsSummary, registerDiagnoseMetricsCommand } from './metrics.js';
import { fetchAdvisorSummary, registerDiagnoseAdvisorCommand } from './advisor.js';
import { runDbChecks, registerDiagnoseDbCommand } from './db.js';
import { fetchLogsSummary, registerDiagnoseLogsCommand } from './logs.js';

function sectionHeader(title: string): string {
  return `── ${title} ${'─'.repeat(Math.max(0, 44 - title.length))}`;
}

interface DiagnosticContext {
  metrics: unknown | null;
  advisor: unknown | null;
  db: unknown | null;
  logs: unknown | null;
  errors: string[];
}

async function collectDiagnosticData(
  projectId: string,
  ossMode: boolean,
  apiUrl?: string,
): Promise<DiagnosticContext> {
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

  const errors: string[] = [];
  let metrics: unknown | null = null;
  let advisor: unknown | null = null;
  let db: unknown | null = null;
  let logs: unknown | null = null;

  if (metricsResult.status === 'fulfilled') {
    const data = metricsResult.value;
    metrics = data.metrics.map((m) => {
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
    errors.push(metricsResult.reason?.message ?? 'Metrics unavailable');
  }

  if (advisorResult.status === 'fulfilled') {
    advisor = advisorResult.value;
  } else {
    errors.push(advisorResult.reason?.message ?? 'Advisor unavailable');
  }

  if (dbResult.status === 'fulfilled') {
    db = dbResult.value;
  } else {
    errors.push(dbResult.reason?.message ?? 'DB checks unavailable');
  }

  if (logsResult.status === 'fulfilled') {
    logs = logsResult.value;
  } else {
    errors.push(logsResult.reason?.message ?? 'Logs unavailable');
  }

  return { metrics, advisor, db, logs, errors };
}

export function registerDiagnoseCommands(diagnoseCmd: Command): void {
  // Comprehensive report (no subcommand)
  diagnoseCmd
    .description('Backend diagnostics — run with no subcommand for a full health report')
    .option('--ai <question>', 'Ask AI to analyze your diagnostic data (1-2000 chars)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      const usageEvent = opts.ai ? 'cli.diagnose.ai' : 'cli.diagnose';
      try {
        await requireAuth(apiUrl);
        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();

        const projectId = config.project_id;
        const projectName = config.project_name;
        const ossMode = config.project_id === 'oss-project';
        trackDiagnose(opts.ai ? 'ai' : 'report', config);

        // AI analysis mode
        if (opts.ai) {
          const question = String(opts.ai).trim();
          if (question.length === 0 || question.length > 2000) {
            throw new CLIError('Question must be between 1 and 2000 characters.');
          }

          const s = !json ? clack.spinner() : null;
          s?.start('Collecting diagnostic data...');

          const data = await collectDiagnosticData(projectId, ossMode, apiUrl);

          const cliVersion = process.env.CLI_VERSION || 'unknown';

          s?.stop('Data collected');

          if (!json) {
            console.log(`\n  AI Diagnosis — ${projectName}\n`);
            console.log(sectionHeader('Question'));
            console.log(`  ${question}\n`);
            console.log(sectionHeader('Analysis'));
          }

          let sessionId: string | undefined;
          let fullText = '';
          const jsonEvents: Record<string, unknown>[] = [];
          let streamError: CLIError | undefined;

          await streamDiagnosticAnalysis({
            project_id: projectId,
            question,
            context: {
              context_version: 'diagnostic-v1',
              metrics: data.metrics ?? undefined,
              advisor: data.advisor ?? undefined,
              db: data.db ?? undefined,
              logs: data.logs ?? undefined,
              client_info: {
                cli_version: cliVersion,
                node_version: process.version,
                os: `${os.platform()} ${os.release()}`,
              },
            },
          }, (event) => {
            // Capture sessionId and errors before any early return
            if (event.type === 'done') {
              sessionId = event.data.session_id as string | undefined;
            }
            if (event.type === 'error') {
              streamError = new CLIError(String(event.data.message ?? 'Unknown diagnostic error'));
            }

            if (json) {
              jsonEvents.push({ type: event.type, ...event.data });
              return;
            }

            switch (event.type) {
              case 'delta':
                process.stdout.write(String(event.data.text ?? ''));
                fullText += String(event.data.text ?? '');
                break;
              case 'tool_call':
                console.log(`\n  [calling ${event.data.tool_name}...]`);
                break;
              case 'tool_result':
                // silently consume tool results
                break;
              case 'done':
                break;
              case 'error':
                console.error(`\n  Error: ${streamError?.message ?? 'Unknown error'}`);
                break;
            }
          }, apiUrl);

          if (streamError) {
            throw streamError;
          }

          if (!json) {
            // Ensure newline after streamed text
            if (fullText && !fullText.endsWith('\n')) console.log('');
            console.log('');
          }

          if (json) {
            outputJson({ sessionId, events: jsonEvents });
          }

          // Optional rating prompt (interactive only)
          if (!json && sessionId) {
            const ratingChoice = await clack.select({
              message: 'Was this analysis helpful?',
              options: [
                { value: 'skip', label: 'Skip', hint: 'no rating' },
                { value: 'helpful', label: 'Helpful', hint: 'solved or pointed in right direction' },
                { value: 'not_helpful', label: 'Not helpful', hint: 'didn\'t apply to the problem' },
                { value: 'incorrect', label: 'Incorrect', hint: 'diagnosis was wrong or misleading' },
              ],
            });

            if (!clack.isCancel(ratingChoice) && ratingChoice !== 'skip') {
              try {
                await rateDiagnosticSession(
                  sessionId,
                  ratingChoice as 'helpful' | 'not_helpful' | 'incorrect',
                  undefined,
                  apiUrl,
                );
                clack.log.success('Thanks for your feedback!');
              } catch {
                clack.log.warn('Failed to submit rating.');
              }
            }
          }

          await reportCliUsage(usageEvent, true);
          return;
        }

        // Standard report mode
        const data = await collectDiagnosticData(projectId, ossMode, apiUrl);

        if (json) {
          outputJson({ project: projectName, ...data });
        } else {
          console.log(`\n  InsForge Health Report — ${projectName}\n`);

          // Metrics section
          console.log(sectionHeader('System Metrics (last 1h)'));
          if (data.metrics) {
            const metricsArr = data.metrics as { metric: string; latest: number | null }[];
            if (metricsArr.length === 0) {
              console.log('  No metrics data available.');
            } else {
              const vals: Record<string, number> = {};
              for (const m of metricsArr) {
                if (m.latest !== null) vals[m.metric] = m.latest;
              }
              const cpu = vals.cpu_usage !== undefined ? `${vals.cpu_usage.toFixed(1)}%` : 'N/A';
              const mem = vals.memory_usage !== undefined ? `${vals.memory_usage.toFixed(1)}%` : 'N/A';
              const disk = vals.disk_usage !== undefined ? `${vals.disk_usage.toFixed(1)}%` : 'N/A';
              const netIn = vals.network_in !== undefined ? formatBytesCompact(vals.network_in) + '/s' : 'N/A';
              const netOut = vals.network_out !== undefined ? formatBytesCompact(vals.network_out) + '/s' : 'N/A';
              console.log(`  CPU: ${cpu}   Memory: ${mem}`);
              console.log(`  Disk: ${disk}  Network: ↓${netIn} ↑${netOut}`);
            }
          } else {
            console.log(`  N/A — ${data.errors.find((e) => e.includes('Metrics') || e.includes('Platform')) ?? 'unavailable'}`);
          }

          // Advisor section
          console.log('\n' + sectionHeader('Advisor Scan'));
          if (data.advisor) {
            const scan = data.advisor as { scannedAt: string; status: string; summary: { critical: number; warning: number; info: number } };
            const date = new Date(scan.scannedAt).toLocaleDateString();
            console.log(`  ${date} (${scan.status}) — ${scan.summary.critical} critical · ${scan.summary.warning} warning · ${scan.summary.info} info`);
          } else {
            console.log(`  N/A — ${data.errors.find((e) => e.includes('Advisor') || e.includes('Platform')) ?? 'unavailable'}`);
          }

          // DB section
          console.log('\n' + sectionHeader('Database'));
          if (data.db) {
            const db = data.db as Record<string, Record<string, unknown>[]>;
            const conn = db.connections?.[0];
            const cache = db['cache-hit']?.[0];
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
            console.log(`  N/A — ${data.errors.find((e) => e.includes('DB')) ?? 'unavailable'}`);
          }

          // Logs section
          console.log('\n' + sectionHeader('Recent Errors (last 100 logs/source)'));
          if (data.logs) {
            const summaries = data.logs as { source: string; errors: unknown[] }[];
            const parts = summaries.map((s) => `${s.source}: ${s.errors.length}`);
            console.log(`  ${parts.join('  ')}`);
          } else {
            console.log(`  N/A — ${data.errors.find((e) => e.includes('Logs')) ?? 'unavailable'}`);
          }

          console.log('');
        }
        await reportCliUsage(usageEvent, true);
      } catch (err) {
        await reportCliUsage(usageEvent, false);
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
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
