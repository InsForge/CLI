import type { Command } from 'commander';
import { ossFetch } from '../lib/api/oss.js';
import { requireAuth } from '../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../lib/errors.js';
import { outputJson } from '../lib/output.js';

const VALID_SOURCES = ['insforge.logs', 'postgREST.logs', 'postgres.logs', 'function.logs'] as const;
const SOURCE_LOOKUP = new Map(VALID_SOURCES.map((s) => [s.toLowerCase(), s]));

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <source>')
    .description('Fetch backend container logs (insforge.logs | postgREST.logs | postgres.logs | function.logs)')
    .option('--limit <n>', 'Number of log entries to return', '20')
    .action(async (source: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const resolved = SOURCE_LOOKUP.get(source.toLowerCase());
        if (!resolved) {
          throw new CLIError(`Invalid log source "${source}". Valid sources: ${VALID_SOURCES.join(', ')}`);
        }

        const limit = parseInt(opts.limit, 10) || 20;
        const res = await ossFetch(`/api/logs/${encodeURIComponent(resolved)}?limit=${limit}`);
        const data = await res.json();

        if (json) {
          outputJson(data);
        } else {
          const logs = Array.isArray(data) ? data : (data as Record<string, unknown>).logs;
          if (!Array.isArray(logs) || !logs.length) {
            console.log('No logs found.');
            return;
          }
          for (const entry of logs) {
            if (typeof entry === 'string') {
              console.log(entry);
            } else {
              const e = entry as Record<string, unknown>;
              const ts = e.timestamp ?? e.time ?? '';
              const msg = e.message ?? e.msg ?? e.log ?? JSON.stringify(e);
              console.log(`${ts}  ${msg}`);
            }
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
