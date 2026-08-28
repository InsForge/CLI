import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type * as ErrorsModule from '../../lib/errors.js';
import { CLIError } from '../../lib/errors.js';

const ossFetchMock = vi.hoisted(() => vi.fn());
const outputJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/oss.js', () => ({ ossFetch: ossFetchMock }));
vi.mock('../../lib/credentials.js', () => ({ requireAuth: vi.fn().mockResolvedValue(undefined) }));
const trackCommandUsageMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/command-telemetry.js', () => ({ trackCommandUsage: trackCommandUsageMock }));
vi.mock('../../lib/output.js', () => ({ outputJson: outputJsonMock }));
vi.mock('../../lib/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorsModule>();
  return {
    ...actual,
    handleError: (err: unknown) => { throw err; },
  };
});

import { Command } from 'commander';
import { registerComputeLogsCommand, sanitizeLogMessage, parseLimit, formatLogLine } from './logs.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI_C1 = String.fromCharCode(0x9b); // 8-bit CSI

function run(args: string[]) {
  const cmd = new Command();
  cmd.exitOverride();
  cmd.option('--json');
  const compute = cmd.command('compute');
  registerComputeLogsCommand(compute);
  return cmd.parseAsync(['node', 'insforge', ...args]);
}

function page(lines: unknown[], nextToken: string | null = null) {
  return { json: async () => ({ lines, nextToken }) };
}

describe('compute logs', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    ossFetchMock.mockReset();
    outputJsonMock.mockReset();
    trackCommandUsageMock.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it('calls the container logs endpoint with a clamped limit', async () => {
    ossFetchMock.mockResolvedValueOnce(page([]));
    await run(['compute', 'logs', 'my api', '--limit', '5000']);
    expect(ossFetchMock).toHaveBeenCalledWith('/api/compute/services/my%20api/logs?limit=1000');
    expect(logSpy).toHaveBeenCalledWith('No logs found.');
  });

  it('forwards --next-token as next_token', async () => {
    ossFetchMock.mockResolvedValueOnce(page([]));
    await run(['compute', 'logs', 'svc', '--next-token', 'abc']);
    expect(ossFetchMock.mock.calls[0][0]).toBe('/api/compute/services/svc/logs?limit=100&next_token=abc');
  });

  it('prints formatted lines', async () => {
    ossFetchMock.mockResolvedValueOnce(page(
      [{ timestamp: 0, message: 'hello', region: 'sjc', instance: 'abc123' }], 'tok',
    ));
    await run(['compute', 'logs', 'svc']);
    expect(logSpy).toHaveBeenCalledWith('1970-01-01T00:00:00.000Z  [sjc abc123]  hello');
  });

  it('emits the full result (with cursor) under --json, sanitized', async () => {
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1, message: `x${CSI_C1}31my` }], 'tok'));
    await run(['--json', 'compute', 'logs', 'svc']);
    expect(outputJsonMock).toHaveBeenCalledWith({
      lines: [{ timestamp: 1, message: 'x31my' }],
      nextToken: 'tok',
    });
  });

  it('--follow forwards the cursor on the next poll and prints per batch', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1, message: 'one' }], 'tokA'));
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 2, message: 'two' }], 'tokB'));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    expect(logSpy).toHaveBeenCalledWith('1970-01-01T00:00:00.001Z  one');
    await vi.advanceTimersByTimeAsync(2000);
    expect(ossFetchMock.mock.calls[1][0]).toBe('/api/compute/services/svc/logs?limit=100&next_token=tokA');
    expect(logSpy).toHaveBeenCalledWith('1970-01-01T00:00:00.002Z  two');
    await vi.advanceTimersByTimeAsync(2000);
    expect(ossFetchMock.mock.calls[2][0]).toBe('/api/compute/services/svc/logs?limit=100&next_token=tokB');
  });

  it('--follow without a cursor drops already-printed lines on refetch', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 5, message: 'seen' }], null));
    ossFetchMock.mockResolvedValueOnce(page([
      { timestamp: 5, message: 'seen' },
      { timestamp: 5, message: 'sibling' },
      { timestamp: 9, message: 'fresh' },
    ], null));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ossFetchMock.mock.calls[1][0]).toBe('/api/compute/services/svc/logs?limit=100');
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.filter((l: string) => l.includes('seen'))).toHaveLength(1);
    expect(printed.filter((l: string) => l.includes('sibling'))).toHaveLength(1);
    expect(printed.some((l: string) => l.includes('fresh'))).toBe(true);
  });

  it('--follow does not reprint a frozen cursor batch', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1, message: 'one' }], 'tokA'));
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1, message: 'one' }], 'tokA'));
    ossFetchMock.mockResolvedValueOnce(page([
      { timestamp: 1, message: 'one' },
      { timestamp: 2, message: 'two' },
    ], 'tokA'));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.filter((l: string) => l.includes('one'))).toHaveLength(1);
    expect(printed.filter((l: string) => l.includes('two'))).toHaveLength(1);
  });

  it('--follow clears a stale cursor when the server stops returning one', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1, message: 'one' }], 'tokA'));
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 2, message: 'two' }], null));
    ossFetchMock.mockResolvedValueOnce(page([
      { timestamp: 2, message: 'two' },
      { timestamp: 3, message: 'three' },
    ], null));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000); // poll 1: uses tokA, returns null cursor
    await vi.advanceTimersByTimeAsync(2000); // poll 2: must NOT reuse tokA
    expect(ossFetchMock.mock.calls[1][0]).toBe('/api/compute/services/svc/logs?limit=100&next_token=tokA');
    expect(ossFetchMock.mock.calls[2][0]).toBe('/api/compute/services/svc/logs?limit=100');
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.filter((l: string) => l.includes('two'))).toHaveLength(1);
    expect(printed.some((l: string) => l.includes('three'))).toBe(true);
  });

  it('--follow keeps genuinely repeated identical lines at the boundary timestamp', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([
      { timestamp: 5, message: 'dup' },
      { timestamp: 5, message: 'dup' },
    ], null));
    ossFetchMock.mockResolvedValueOnce(page([
      { timestamp: 5, message: 'dup' },
      { timestamp: 5, message: 'dup' },
      { timestamp: 5, message: 'dup' },
    ], null));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.filter((l: string) => l.includes('dup'))).toHaveLength(3);
  });

  it('--follow prints an advancing-cursor page verbatim, even within one millisecond', async () => {
    vi.useFakeTimers();
    // Docker cursors are nanosecond precision; both pages share a millisecond.
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1000, message: 'tick' }], 'ns1'));
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1000, message: 'tick' }], 'ns2'));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.filter((l: string) => l.includes('tick'))).toHaveLength(2);
  });

  it('--follow prints an older-timestamp line arriving behind a new cursor', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 5000, message: 'newer' }], 'ns1'));
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 0, message: 'unparseable-ts' }], 'ns2'));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.some((l: string) => l.includes('unparseable-ts'))).toBe(true);
  });

  it('--follow prints a line with an unusable timestamp instead of dropping it', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 5000, message: 'newer' }], null));
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: null, message: 'no-ts' }], null));
    // Same window re-sent: the undated line must not repeat.
    ossFetchMock.mockResolvedValue(page([{ timestamp: null, message: 'no-ts' }], null));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.filter((l: string) => l.includes('no-ts'))).toHaveLength(1);
  });

  it('--follow ignores an implausibly future timestamp when advancing the watermark', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([
      { timestamp: 1000, message: 'real' },
      { timestamp: 4102444800000, message: 'year-2100' },
    ], null));
    ossFetchMock.mockResolvedValue(page([{ timestamp: 2000, message: 'later-real' }], null));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.some((l: string) => l.includes('later-real'))).toBe(true);
  });

  it('--follow does not reprint a future-dated line on every poll', async () => {
    vi.useFakeTimers();
    const future = Date.now() + 60 * 60 * 1000;
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1000, message: 'real' }], null));
    ossFetchMock.mockResolvedValue(page([
      { timestamp: 1000, message: 'real' },
      { timestamp: future, message: 'from-the-future' },
    ], null));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.filter((l: string) => l.includes('from-the-future'))).toHaveLength(1);
  });

  it('--follow does not reprint dated lines when a page also carries an undated one', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1000, message: 'dated' }], null));
    ossFetchMock.mockResolvedValue(page([
      { timestamp: 1000, message: 'dated' },
      { timestamp: null, message: 'undated' },
    ], null));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.filter((l: string) => l.includes('dated') && !l.includes('undated'))).toHaveLength(1);
  });

  it('--follow keeps tailing when the local clock is far behind the provider', async () => {
    vi.useFakeTimers();
    // Reader's clock 10 minutes behind the timestamps the server sends.
    const serverNow = 1_700_000_000_000;
    vi.setSystemTime(serverNow - 10 * 60 * 1000);
    // The window also carries an OLD line, the way a real scrolling window
    // does — that older line satisfies the plausibility bound even on a slow
    // clock, so without a timestamp-keyed undated dedupe the live lines
    // collapse into one and the tail goes silent.
    const win = (n: number) => page([
      { timestamp: serverNow - 10 * 60 * 1000, message: 'listening on :8080' },
      { timestamp: serverNow + n, message: 'EADDRINUSE, retrying' },
    ], null);
    ossFetchMock.mockResolvedValueOnce(win(0));
    ossFetchMock.mockResolvedValueOnce(win(1));
    ossFetchMock.mockResolvedValueOnce(win(2));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    // All three distinct lines must appear; a global clock bound printed only the first.
    expect(printed.filter((l: string) => l.includes('EADDRINUSE'))).toHaveLength(3);
  });

  it('--follow survives a page in which every line is implausibly future', async () => {
    vi.useFakeTimers();
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1000, message: 'real-1' }], null));
    // A uniform all-future page must not disable the bound for later polls.
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: future, message: 'bogus-future' }], null));
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 2000, message: 'real-2' }], null));
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 3000, message: 'real-3' }], null));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.some((l: string) => l.includes('real-2'))).toBe(true);
    expect(printed.some((l: string) => l.includes('real-3'))).toBe(true);
  });

  it('emits stable telemetry for the command', async () => {
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1, message: 'x' }], null));
    await run(['compute', 'logs', 'svc']);
    expect(trackCommandUsageMock).toHaveBeenCalledWith('compute', 'logs', true, {
      result_count: 1,
      follow: false,
    });
  });

  it('--follow retries transient poll failures and keeps tailing', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1, message: 'one' }], 'tokA'));
    ossFetchMock.mockRejectedValueOnce(new CLIError('rate limited', 1, 'RATE_LIMITED', 429));
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 2, message: 'two' }], 'tokB'));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000); // poll 1 -> 429
    await vi.advanceTimersByTimeAsync(4000); // backoff
    await vi.advanceTimersByTimeAsync(2000); // poll 2 -> succeeds
    expect(logSpy).toHaveBeenCalledWith('1970-01-01T00:00:00.002Z  two');
  });

  it('--json --follow emits NDJSON per line', async () => {
    vi.useFakeTimers();
    ossFetchMock.mockResolvedValueOnce(page([{ timestamp: 1, message: 'a' }], 'tok'));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['--json', 'compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ timestamp: 1, message: 'a' }));
    expect(outputJsonMock).not.toHaveBeenCalled();
  });
});

describe('fetchComputeLogs boundary', () => {
  it('normalizes the shape, sanitizes strings, and drops an empty cursor to null', async () => {
    ossFetchMock.mockResolvedValueOnce({
      json: async () => ({
        lines: [{ timestamp: 7, message: `a${ESC}[31mb`, region: `s${ESC}[0mjc`, instance: 'i1', extra: 'dropped' }],
        nextToken: '',
      }),
    });
    const { fetchComputeLogs } = await import('./logs.js');
    const out = await fetchComputeLogs('svc', { limit: 10 });
    expect(out).toEqual({
      lines: [{ timestamp: 7, message: 'ab', region: 'sjc', instance: 'i1' }],
      nextToken: null,
    });
  });

  it('tolerates a malformed body', async () => {
    ossFetchMock.mockResolvedValueOnce({ json: async () => null });
    const { fetchComputeLogs } = await import('./logs.js');
    expect(await fetchComputeLogs('svc', { limit: 10 })).toEqual({ lines: [], nextToken: null });
  });
});

describe('sanitizeLogMessage', () => {
  it('strips ANSI CSI/OSC sequences and control chars, keeps tabs', () => {
    expect(sanitizeLogMessage(`${ESC}[31mred${ESC}[0m ok`)).toBe('red ok');
    expect(sanitizeLogMessage(`${ESC}]0;evil title${BEL}text`)).toBe('text');
    expect(sanitizeLogMessage('a\rb\nc')).toBe('a b c');
    expect(sanitizeLogMessage('keep\ttabs')).toBe('keep\ttabs');
  });

  it('strips 8-bit C1 controls (CSI/OSC without ESC)', () => {
    expect(sanitizeLogMessage(`x${CSI_C1}31my`)).toBe('x31my');
    expect(sanitizeLogMessage(String.fromCharCode(0x90) + 'dcs')).toBe('dcs');
  });
});

describe('formatLogLine', () => {
  it('falls back to the raw value instead of throwing on a bad timestamp', () => {
    expect(formatLogLine({ timestamp: Number.NaN, message: 'm' })).toContain('m');
    expect(() => formatLogLine({ timestamp: undefined as unknown as number, message: 'm' })).not.toThrow();
  });
});

describe('parseLimit', () => {
  it('clamps into 1-1000 and defaults malformed input', () => {
    expect(parseLimit('0')).toBe(1);
    expect(parseLimit('5000')).toBe(1000);
    expect(parseLimit('abc')).toBe(100);
    expect(parseLimit('')).toBe(100);
    expect(parseLimit(undefined)).toBe(100);
    expect(parseLimit('250')).toBe(250);
  });
});
