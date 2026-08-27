import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, isTransientApiError } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

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
const DEFAULT_LIMIT = 100;
// A long-running tail will meet a 429 (the logs limiter is shared per-IP) or
// a passing 5xx; retry those with backoff and only give up after a run of
// consecutive failures. Non-transient errors (401/403/404) still fail fast.
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

// Container output is attacker-adjacent data: a compromised (or just chatty)
// app can emit ANSI/OSC escape sequences that reprogram the reader's
// terminal. Strip ESC-led sequences (a trailing bare-ESC arm defangs any
// form the specific arms miss) and 8-bit C1 controls (which encode CSI/OSC
// without ESC); collapse remaining C0 controls except tab to a space.
// Applied at the fetch boundary so every output mode — including --json,
// where JSON.stringify leaves C1 bytes raw — is covered.
// eslint-disable-next-line no-control-regex
const TERMINAL_SEQUENCES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]|[\u0080-\u009f]|\u001b/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RUNS = /[\u0000-\u0008\u000a-\u001f\u007f]+/g;

export function sanitizeLogMessage(message: string): string {
  // Sequences (and their C1 single-byte introducers) vanish outright; runs of
  // remaining C0 controls become one space so a multi-line message (a stack
  // trace delivered as a single entry) stays readable instead of gluing
  // "line1line2" together.
  return message.replace(TERMINAL_SEQUENCES, '').replace(CONTROL_RUNS, ' ');
}

// Exact 1-1000 contract: malformed input falls back to the default (same as
// omitting the flag); finite values clamp into range, so `--limit 0` -> 1.
export function parseLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(n), 1000));
}

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
  const lines = (Array.isArray(body?.lines) ? body.lines : []).map((l) => ({
    ...l,
    message: sanitizeLogMessage(String(l.message ?? '')),
  }));
  return {
    lines,
    nextToken: typeof body?.nextToken === 'string' && body.nextToken.length > 0 ? body.nextToken : null,
  };
}

export function registerComputeLogsCommand(computeCmd: Command): void {
  computeCmd
    .command('logs <id>')
    .description('Get compute service container logs (stdout/stderr)')
    .option('--limit <n>', 'Max number of log lines per fetch (1-1000)', String(DEFAULT_LIMIT))
    .option('-f, --follow', 'Keep polling for new lines (Ctrl+C to stop). With --json, emits NDJSON: one log-line object per line')
    .option('--next-token <token>', 'Resume from a cursor returned by a previous --json call')
    .action(async (id: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const limit = parseLimit(opts.limit);
        const result = await fetchComputeLogs(id, { limit, nextToken: opts.nextToken });

        await trackCommandUsage('compute', 'logs', true, {
          result_count: result.lines.length,
          follow: Boolean(opts.follow),
        });

        if (json && !opts.follow) {
          outputJson(result);
          return;
        }

        const print = (lines: ComputeLogLine[]) => {
          for (const line of lines) {
            console.log(json ? JSON.stringify(line) : formatLogLine(line));
          }
        };

        if (result.lines.length === 0 && !opts.follow) {
          console.log('No logs found.');
          return;
        }
        print(result.lines);

        if (opts.follow) {
          if (!json) console.error('Following logs... (Ctrl+C to stop)');
          let token = result.nextToken;
          // When the provider stops returning a cursor, each poll re-fetches
          // the recent window; drop lines at or before the newest timestamp
          // already printed so they don't repeat. Cursor-based pages don't
          // overlap, so no filter is applied while a token advances.
          let lastTs = result.lines.length > 0 ? result.lines[result.lines.length - 1].timestamp : 0;
          let pollFailures = 0;
          for (;;) {
            await new Promise((r) => setTimeout(r, FOLLOW_INTERVAL_MS));
            let page: ComputeLogsResult;
            try {
              page = await fetchComputeLogs(id, { limit, nextToken: token ?? undefined });
              pollFailures = 0;
            } catch (pollErr) {
              pollFailures += 1;
              if (!isTransientApiError(pollErr) || pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                throw pollErr;
              }
              await new Promise((r) => setTimeout(r, Math.min(FOLLOW_INTERVAL_MS * 2 ** pollFailures, 30_000)));
              continue;
            }
            const fresh = token ? page.lines : page.lines.filter((l) => l.timestamp > lastTs);
            print(fresh);
            if (fresh.length > 0) {
              lastTs = Math.max(lastTs, fresh[fresh.length - 1].timestamp);
            }
            if (page.nextToken) token = page.nextToken;
          }
        }
      } catch (err) {
        await trackCommandUsage('compute', 'logs', false, {}, err);
        handleError(err, json);
      }
    });
}
