import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

// `compute logs <id>` returns container stdout/stderr ("application logs") —
// the same data the dashboard Logs panel shows. For machine lifecycle events
// (start/stop/exit/restart) use `compute events <id>` instead.
//
// Endpoint: GET /api/compute/services/:id/logs?limit=&next_token=
// Response: { lines: { timestamp, message, instance?, region? }[], nextToken: string | null }
// `nextToken` is an opaque forward cursor; `--follow` polls with it. The
// endpoint is rate-limited server-side (dashboard polls every ~2s), so the
// follow interval stays at 2s.

export interface ComputeLogLine {
  timestamp: number;
  message: string;
  instance?: string;
  region?: string;
}

export interface ComputeLogsResult {
  lines: ComputeLogLine[];
  nextToken: string | null;
}

const FOLLOW_INTERVAL_MS = 2000;

export function formatLogLine(line: ComputeLogLine): string {
  const ts = new Date(line.timestamp).toISOString();
  const where = [line.region, line.instance].filter(Boolean).join(' ');
  return where ? `${ts}  [${where}]  ${line.message}` : `${ts}  ${line.message}`;
}

export async function fetchComputeLogs(
  id: string,
  opts: { limit: number; nextToken?: string },
): Promise<ComputeLogsResult> {
  const params = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.nextToken) params.set('next_token', opts.nextToken);
  const res = await ossFetch(
    `/api/compute/services/${encodeURIComponent(id)}/logs?${params.toString()}`,
  );
  const body = await res.json() as Partial<ComputeLogsResult> | null;
  return {
    lines: Array.isArray(body?.lines) ? body.lines : [],
    nextToken: typeof body?.nextToken === 'string' && body.nextToken.length > 0 ? body.nextToken : null,
  };
}

export function registerComputeLogsCommand(computeCmd: Command): void {
  computeCmd
    .command('logs <id>')
    .description('Get compute service container logs (stdout/stderr)')
    .option('--limit <n>', 'Max number of log lines per fetch (1-1000)', '100')
    .option('-f, --follow', 'Keep polling for new lines (Ctrl+C to stop)')
    .option('--next-token <token>', 'Resume from a cursor returned by a previous --json call')
    .action(async (id: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const limit = Math.max(1, Math.min(Number(opts.limit) || 100, 1000));
        let result = await fetchComputeLogs(id, { limit, nextToken: opts.nextToken });

        if (json && !opts.follow) {
          outputJson(result);
          await reportCliUsage('cli.compute.logs', true);
          return;
        }

        const print = (lines: ComputeLogLine[]) => {
          for (const line of lines) {
            console.log(json ? JSON.stringify(line) : formatLogLine(line));
          }
        };

        if (result.lines.length === 0 && !opts.follow) {
          console.log('No logs found.');
          await reportCliUsage('cli.compute.logs', true);
          return;
        }
        print(result.lines);

        if (opts.follow) {
          if (!json) console.error('Following logs... (Ctrl+C to stop)');
          let token = result.nextToken;
          while (true) {
            await new Promise((r) => setTimeout(r, FOLLOW_INTERVAL_MS));
            result = await fetchComputeLogs(id, { limit, nextToken: token ?? undefined });
            print(result.lines);
            if (result.nextToken) token = result.nextToken;
          }
        }

        await reportCliUsage('cli.compute.logs', true);
      } catch (err) {
        await reportCliUsage('cli.compute.logs', false);
        handleError(err, json);
      }
    });
}
