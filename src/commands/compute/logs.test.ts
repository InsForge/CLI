import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type * as ErrorsModule from '../../lib/errors.js';

const ossFetchMock = vi.hoisted(() => vi.fn());
const outputJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/oss.js', () => ({ ossFetch: ossFetchMock }));
vi.mock('../../lib/credentials.js', () => ({ requireAuth: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/command-telemetry.js', () => ({ trackCommandUsage: vi.fn() }));
vi.mock('../../lib/output.js', () => ({ outputJson: outputJsonMock }));
vi.mock('../../lib/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorsModule>();
  return {
    ...actual,
    handleError: (err: unknown) => { throw err; },
  };
});

import { Command } from 'commander';
import { registerComputeLogsCommand, sanitizeLogMessage, parseLimit } from './logs.js';

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
      { timestamp: 9, message: 'fresh' },
    ], null));
    ossFetchMock.mockResolvedValue(page([]));
    void run(['compute', 'logs', 'svc', '--follow']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ossFetchMock.mock.calls[1][0]).toBe('/api/compute/services/svc/logs?limit=100');
    const printed = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(printed.filter((l: string) => l.includes('seen'))).toHaveLength(1);
    expect(printed.some((l: string) => l.includes('fresh'))).toBe(true);
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

describe('sanitizeLogMessage', () => {
  it('strips ANSI CSI/OSC sequences and control chars, keeps tabs', () => {
    expect(sanitizeLogMessage(`${ESC}[31mred${ESC}[0m ok`)).toBe('red ok');
    expect(sanitizeLogMessage(`${ESC}]0;evil title${BEL}text`)).toBe('text');
    expect(sanitizeLogMessage('a\rb\nc')).toBe('abc');
    expect(sanitizeLogMessage('keep\ttabs')).toBe('keep\ttabs');
  });

  it('strips 8-bit C1 controls (CSI/OSC without ESC)', () => {
    expect(sanitizeLogMessage(`x${CSI_C1}31my`)).toBe('x31my');
    expect(sanitizeLogMessage(String.fromCharCode(0x90) + 'dcs')).toBe('dcs');
  });
});

describe('parseLimit', () => {
  it('clamps into 1-1000 and defaults malformed input', () => {
    expect(parseLimit('0')).toBe(1);
    expect(parseLimit('5000')).toBe(1000);
    expect(parseLimit('abc')).toBe(100);
    expect(parseLimit(undefined)).toBe(100);
    expect(parseLimit('250')).toBe(250);
  });
});
