import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type * as ErrorsModule from '../../lib/errors.js';

const ossFetchMock = vi.hoisted(() => vi.fn());
const outputJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/oss.js', () => ({ ossFetch: ossFetchMock }));
vi.mock('../../lib/credentials.js', () => ({ requireAuth: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/skills.js', () => ({ reportCliUsage: vi.fn() }));
vi.mock('../../lib/output.js', () => ({ outputJson: outputJsonMock }));
vi.mock('../../lib/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorsModule>();
  return {
    ...actual,
    handleError: (err: unknown) => { throw err; },
  };
});

import { Command } from 'commander';
import { registerComputeLogsCommand, formatLogLine } from './logs.js';

function run(args: string[]) {
  const cmd = new Command();
  cmd.exitOverride();
  cmd.option('--json');
  const compute = cmd.command('compute');
  registerComputeLogsCommand(compute);
  return cmd.parseAsync(['node', 'insforge', ...args]);
}

describe('compute logs', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    ossFetchMock.mockReset();
    outputJsonMock.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it('calls the container logs endpoint with a clamped limit', async () => {
    ossFetchMock.mockResolvedValueOnce({ json: async () => ({ lines: [], nextToken: null }) });
    await run(['compute', 'logs', 'my api', '--limit', '5000']);
    expect(ossFetchMock).toHaveBeenCalledWith('/api/compute/services/my%20api/logs?limit=1000');
    expect(logSpy).toHaveBeenCalledWith('No logs found.');
  });

  it('forwards --next-token as next_token', async () => {
    ossFetchMock.mockResolvedValueOnce({ json: async () => ({ lines: [], nextToken: null }) });
    await run(['compute', 'logs', 'svc', '--next-token', 'abc']);
    expect(ossFetchMock.mock.calls[0][0]).toBe('/api/compute/services/svc/logs?limit=100&next_token=abc');
  });

  it('prints formatted lines', async () => {
    ossFetchMock.mockResolvedValueOnce({
      json: async () => ({
        lines: [{ timestamp: 0, message: 'hello', region: 'sjc', instance: 'abc123' }],
        nextToken: 'tok',
      }),
    });
    await run(['compute', 'logs', 'svc']);
    expect(logSpy).toHaveBeenCalledWith('1970-01-01T00:00:00.000Z  [sjc abc123]  hello');
  });

  it('emits the full result (with cursor) under --json', async () => {
    const payload = { lines: [{ timestamp: 1, message: 'x' }], nextToken: 'tok' };
    ossFetchMock.mockResolvedValueOnce({ json: async () => payload });
    await run(['--json', 'compute', 'logs', 'svc']);
    expect(outputJsonMock).toHaveBeenCalledWith(payload);
  });

  it('formatLogLine omits the bracket when no region/instance', () => {
    expect(formatLogLine({ timestamp: 0, message: 'm' })).toBe('1970-01-01T00:00:00.000Z  m');
  });
});

describe('sanitizeLogMessage', () => {
  it('strips ANSI CSI/OSC sequences and control chars, keeps tabs', async () => {
    const { sanitizeLogMessage } = await import('./logs.js');
    expect(sanitizeLogMessage('\u001b[31mred\u001b[0m ok')).toBe('red ok');
    expect(sanitizeLogMessage('\u001b]0;evil title\u0007text')).toBe('text');
    expect(sanitizeLogMessage('a\u0008b\rc')).toBe('abc');
    expect(sanitizeLogMessage('keep\ttabs')).toBe('keep\ttabs');
  });
});
