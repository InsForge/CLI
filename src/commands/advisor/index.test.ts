import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerAdvisorCommands } from './index.js';

vi.mock('../../lib/api/oss.js', () => ({
  triggerAdvisorScan: vi.fn(async () => ({ scanId: 'scan-1', message: 'Scan started' })),
  listAdvisorSuppressions: vi.fn(async () => [
    {
      id: 'sup-1',
      ruleId: 'rls_disabled',
      scope: 'instance',
      affectedObject: 'public.todos',
      reason: 'accepted_risk',
      createdAt: '2026-08-01T00:00:00Z',
    },
  ]),
  createAdvisorSuppression: vi.fn(async () => ({
    id: 'sup-2',
    ruleId: 'rls_disabled',
    scope: 'rule',
    reason: 'false_positive',
    createdAt: '2026-08-01T00:00:00Z',
  })),
  deleteAdvisorSuppression: vi.fn(async () => {}),
}));

vi.mock('../../lib/command-telemetry.js', () => ({
  trackCommandUsage: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>');
  const advisorCmd = program.command('advisor');
  registerAdvisorCommands(advisorCmd);
  return program;
}

async function runWithCapturedLog(program: Command, argv: string[]): Promise<string[]> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    logSpy.mockRestore();
  }
  return logs;
}

describe('advisor commands', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('scan --json emits the scan id', async () => {
    const logs = await runWithCapturedLog(makeProgram(), ['advisor', 'scan', '--json']);
    expect(JSON.parse(logs.join('\n'))).toEqual({ scanId: 'scan-1', message: 'Scan started' });
  });

  it('suppress with --object creates an instance-scoped suppression', async () => {
    const { createAdvisorSuppression } = await import('../../lib/api/oss.js');
    await runWithCapturedLog(makeProgram(), [
      'advisor', 'suppress', 'rls_disabled',
      '--object', 'public.todos',
      '--reason', 'accepted_risk',
      '--json',
    ]);
    expect(createAdvisorSuppression).toHaveBeenCalledWith({
      ruleId: 'rls_disabled',
      scope: 'instance',
      affectedObject: 'public.todos',
      reason: 'accepted_risk',
    });
  });

  it('suppress without --object suppresses the whole rule', async () => {
    const { createAdvisorSuppression } = await import('../../lib/api/oss.js');
    await runWithCapturedLog(makeProgram(), [
      'advisor', 'suppress', 'rls_disabled', '--reason', 'false_positive', '--json',
    ]);
    expect(createAdvisorSuppression).toHaveBeenCalledWith({
      ruleId: 'rls_disabled',
      scope: 'rule',
      reason: 'false_positive',
    });
  });

  it('suppress rejects an invalid --reason without calling the API', async () => {
    const { createAdvisorSuppression } = await import('../../lib/api/oss.js');
    await expect(
      runWithCapturedLog(makeProgram(), [
        'advisor', 'suppress', 'rls_disabled', '--reason', 'nope', '--json',
      ]),
    ).rejects.toThrow('process.exit');
    expect(createAdvisorSuppression).not.toHaveBeenCalled();
  });

  it('suppress requires --note when --reason is "other"', async () => {
    const { createAdvisorSuppression } = await import('../../lib/api/oss.js');
    await expect(
      runWithCapturedLog(makeProgram(), [
        'advisor', 'suppress', 'rls_disabled', '--reason', 'other', '--json',
      ]),
    ).rejects.toThrow('process.exit');
    expect(createAdvisorSuppression).not.toHaveBeenCalled();
  });

  it('suppressions --json lists suppressions', async () => {
    const logs = await runWithCapturedLog(makeProgram(), ['advisor', 'suppressions', '--json']);
    const data = JSON.parse(logs.join('\n')) as { id: string }[];
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('sup-1');
  });

  it('unsuppress --json deletes by id', async () => {
    const { deleteAdvisorSuppression } = await import('../../lib/api/oss.js');
    const logs = await runWithCapturedLog(makeProgram(), ['advisor', 'unsuppress', 'sup-1', '--json']);
    expect(deleteAdvisorSuppression).toHaveBeenCalledWith('sup-1');
    expect(JSON.parse(logs.join('\n'))).toEqual({ deleted: true, suppression_id: 'sup-1' });
  });

  it('tracks telemetry on success', async () => {
    const { trackCommandUsage } = await import('../../lib/command-telemetry.js');
    await runWithCapturedLog(makeProgram(), ['advisor', 'scan', '--json']);
    expect((trackCommandUsage as Mock).mock.calls[0].slice(0, 3)).toEqual(['advisor', 'scan', true]);
  });
});
