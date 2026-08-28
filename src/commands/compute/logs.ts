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
// Tolerance for provider/client clock disagreement when deciding whether a
// timestamp is plausible enough to advance the follow watermark.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

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
  if (raw === '' || raw === null || raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(n), 1000));
}

export function formatLogLine(line: ComputeLogLine): string {
  // A missing/NaN timestamp would make toISOString throw, and in --follow
  // that happens outside the poll try/catch, killing the tail. Fall back to
  // the raw value the way the dashboard does.
  const d = new Date(line.timestamp);
  const ts = Number.isNaN(d.getTime()) ? String(line.timestamp) : d.toISOString();
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
  // Normalize to the documented shape and sanitize every printable string
  // field — region/instance come from the provider API rather than container
  // output, but they end up on the same terminal line.
  //
  // `timestamp` is deliberately NOT coerced to 0 the way the backend does:
  // an unusable timestamp has to stay distinguishable from a genuine 0 so
  // the follow loop prints it once instead of dropping it below the
  // watermark. formatLogLine and maxTs both handle non-finite values.
  const lines = (Array.isArray(body?.lines) ? body.lines : []).map((l): ComputeLogLine => ({
    timestamp: l.timestamp,
    message: sanitizeLogMessage(String(l.message ?? '')),
    ...(l.instance !== undefined ? { instance: sanitizeLogMessage(String(l.instance)) } : {}),
    ...(l.region !== undefined ? { region: sanitizeLogMessage(String(l.region)) } : {}),
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

        // Emitted before the tail starts, because a --follow run never
        // reaches the end of the action. NOT awaited in follow mode:
        // trackCommandUsage ends by flushing and shutting down the PostHog
        // client over the network, which stalls the tail before its first
        // poll (observed live: nothing printed and no second request while
        // the flush retried).
        const usage = trackCommandUsage('compute', 'logs', true, {
          result_count: result.lines.length,
          follow: Boolean(opts.follow),
        });
        if (!opts.follow) await usage;

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
          // Dedupe only when the cursor did NOT advance: a cursorless poll
          // re-fetches the recent window, and a frozen cursor (the server
          // handing back the token it was given) would otherwise repeat its
          // batch forever. When the cursor advances the server guarantees a
          // non-overlapping page, so it prints verbatim — filtering it on a
          // millisecond watermark would silently drop lines whose provider
          // timestamps share a millisecond (docker cursors are nanosecond
          // precision) or arrive out of order.
          //
          // Within a re-sent window the watermark is the newest timestamp
          // seen, plus per-key occurrence COUNTS for the lines sharing it, so
          // genuinely repeated identical messages still print.
          const lineKey = (l: ComputeLogLine) => `${l.region ?? ''}|${l.instance ?? ''}|${l.message}`;
          // A timestamp that can't be ordered against the watermark is still a
          // stable identifier for the line. Keying the undated dedupe on it
          // keeps identical messages at DIFFERENT timestamps distinct, so a
          // crash loop emitting the same text every second is never collapsed
          // into a single printed line; a genuinely re-sent line (same
          // timestamp, same text) is still suppressed.
          const undatedKey = (l: ComputeLogLine) => `${String(l.timestamp)}|${lineKey(l)}`;
          // Max, not last: a page arriving unsorted must not move the
          // watermark backwards. Non-finite timestamps are skipped (they'd
          // poison the max into NaN, which compares false against everything
          // and reprints the whole page), and so are implausibly future ones
          // — a single year-2100 line would otherwise pin the watermark and
          // silently drop every real line after it.
          // A timestamp is "positionable" only if it can be compared against
          // the watermark at all. Anything else — non-finite, or implausibly
          // far in the future — is treated as undated everywhere, so it can
          // neither pin the watermark nor slip past the dedupe and reprint on
          // every poll.
          //
          // The future bound is scoped PER PAGE, not to the local clock alone:
          // Date.now() is the reader's clock while the timestamps are the
          // provider's. If a laptop resumed from sleep is minutes behind NTP,
          // a global bound would reject every legitimate line and drop the
          // whole tail into content-only dedupe — a silent dead tail on
          // exactly the crash loop you ran `-f` to watch. So if nothing in
          // the page looks plausible, the disagreement is with our clock and
          // the bound is not applied.
          // Trust is STICKY: a page can earn it but never give it back.
          // Recomputing per page would let a page in which every line is
          // implausibly future disable the bound outright — the very state
          // the bound exists to prevent — and re-pin the watermark to a bogus
          // timestamp, killing the tail permanently.
          let clockTrusted = false;
          const positionableFor = (lines: ComputeLogLine[]) => {
            const bound = Date.now() + CLOCK_SKEW_MS;
            clockTrusted = clockTrusted || lines.some((l) => Number.isFinite(l.timestamp) && l.timestamp <= bound);
            return (ts: number) => Number.isFinite(ts) && (!clockTrusted || ts <= bound);
          };
          let positionable = positionableFor(result.lines);
          const maxTs = (lines: ComputeLogLine[]) => lines.reduce(
            (m, l) => (positionable(l.timestamp) && l.timestamp > m ? l.timestamp : m),
            0,
          );
          let lastTs = maxTs(result.lines);
          // Occurrence COUNTS, not a set: identical messages repeated at the
          // boundary timestamp are real lines — suppress only as many as were
          // already printed.
          const lastTsCounts = new Map<string, number>();
          for (const l of result.lines) {
            if (l.timestamp === lastTs) {
              const k = lineKey(l);
              lastTsCounts.set(k, (lastTsCounts.get(k) ?? 0) + 1);
            }
          }
          // Lines whose timestamp is unusable (the Fly driver maps an
          // unparseable one to 0/NaN) can't be positioned against the
          // watermark, so a re-sent window is deduped against the previous
          // page's occurrences of the same line instead.
          const undatedCounts = (lines: ComputeLogLine[]) => {
            const m = new Map<string, number>();
            for (const l of lines) {
              if (positionable(l.timestamp)) continue;
              const k = undatedKey(l);
              m.set(k, (m.get(k) ?? 0) + 1);
            }
            return m;
          };
          let prevUndated = undatedCounts(result.lines);
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
            // Re-scope the plausibility bound to this page before any use.
            positionable = positionableFor(page.lines);
            // `token` still holds the cursor this request was made with, so a
            // frozen token (nextToken === token) and a null token both keep
            // the dedupe.
            const cursorAdvanced = page.nextToken !== null && page.nextToken !== token;
            const suppress = new Map(lastTsCounts);
            const undatedSuppress = new Map(prevUndated);
            const fresh: ComputeLogLine[] = [];
            for (const l of page.lines) {
              if (cursorAdvanced) {
                fresh.push(l);
                continue;
              }
              if (!positionable(l.timestamp)) {
                const k = undatedKey(l);
                const seen = undatedSuppress.get(k) ?? 0;
                if (seen > 0) {
                  undatedSuppress.set(k, seen - 1);
                  continue;
                }
                fresh.push(l);
                continue;
              }
              if (l.timestamp < lastTs) continue;
              if (l.timestamp === lastTs) {
                const k = lineKey(l);
                const remaining = suppress.get(k) ?? 0;
                if (remaining > 0) {
                  suppress.set(k, remaining - 1);
                  continue;
                }
              }
              fresh.push(l);
            }
            print(fresh);
            // An advanced cursor means the next page can't overlap this one.
            prevUndated = cursorAdvanced ? new Map() : undatedCounts(page.lines);
            if (fresh.length > 0) {
              // Monotonic: a page whose fresh lines are all undated yields
              // maxTs 0, and letting the watermark retreat would reprint
              // everything above it on the next poll.
              const newTs = maxTs(fresh);
              if (newTs > lastTs) {
                lastTs = newTs;
                lastTsCounts.clear();
              }
              for (const l of fresh) {
                if (l.timestamp === lastTs) {
                  const k = lineKey(l);
                  lastTsCounts.set(k, (lastTsCounts.get(k) ?? 0) + 1);
                }
              }
            }
            // Take the cursor as the server reports it, including null: a
            // stale token must not survive the transition, or the loop keeps
            // re-fetching from a cursor the provider has abandoned and the
            // no-cursor dedupe above never engages.
            token = page.nextToken;
          }
        }
      } catch (err) {
        await trackCommandUsage('compute', 'logs', false, {}, err);
        handleError(err, json);
      }
    });
}
