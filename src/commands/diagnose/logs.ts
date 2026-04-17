import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackDiagnose, shutdownAnalytics } from '../../lib/analytics.js';

const LOG_SOURCES = ['insforge.logs', 'postgREST.logs', 'postgres.logs', 'function.logs', 'function-deploy.logs'] as const;

const ERROR_PATTERN = /\b(error|fatal|panic)\b/i;

/** Maps source names to their API paths. Most use /api/logs/{source}, but some have custom paths. */
const SOURCE_PATH: Record<string, string> = {
  'function-deploy.logs': '/api/logs/functions/build-logs',
};

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

function parseLogEntry(entry: unknown): { ts: string; msg: string } {
  if (typeof entry === 'string') {
    return { ts: '', msg: entry };
  }
  const e = entry as Record<string, unknown>;
  const ts = String(e.timestamp ?? e.time ?? '');
  const msg = String(e.message ?? e.msg ?? e.log ?? JSON.stringify(e));
  return { ts, msg };
}

function getLogPath(source: string, limit: number): string {
  const custom = SOURCE_PATH[source];
  if (custom) return `${custom}?limit=${limit}`;
  return `/api/logs/${encodeURIComponent(source)}?limit=${limit}`;
}

async function fetchSourceLogs(source: string, limit: number): Promise<SourceSummary> {
  const res = await ossFetch(getLogPath(source, limit));
  const data = await res.json();
  const logs = Array.isArray(data) ? data : ((data as Record<string, unknown>).logs as unknown[]) ?? [];

  const errors: LogEntry[] = [];
  for (const entry of logs) {
    const { ts, msg } = parseLogEntry(entry);
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
        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();
        trackDiagnose('logs', config);

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
        await shutdownAnalytics();
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
