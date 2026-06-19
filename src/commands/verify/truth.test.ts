import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerVerifyTruthCommand } from './truth.js';

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1', project_name: 'n', org_id: 'o1', region: 'us-east',
    api_key: 'key', oss_host: 'https://h',
  })),
}));
vi.mock('../../lib/api/oss.js', () => ({ runRawSql: vi.fn() }));
vi.mock('../../lib/analytics.js', () => ({
  trackVerifyFinding: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json');
  registerVerifyTruthCommand(program.command('verify'));
  return program;
}

describe('verify truth (command)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    const { runRawSql } = await import('../../lib/api/oss.js');
    (runRawSql as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('rejects a non-read query before touching the DB', async () => {
    const { runRawSql } = await import('../../lib/api/oss.js');
    await expect(
      makeProgram().parseAsync(['verify', 'truth', '--query', 'delete from t', '--expect', '1', '--json'], { from: 'user' }),
    ).rejects.toThrow(/exit:/);
    expect(runRawSql).not.toHaveBeenCalled();
  });

  it('rejects when both --expect and --expect-count are given', async () => {
    const { runRawSql } = await import('../../lib/api/oss.js');
    await expect(
      makeProgram().parseAsync(['verify', 'truth', '--query', 'select 1', '--expect', '1', '--expect-count', '1', '--json'], { from: 'user' }),
    ).rejects.toThrow(/exit:/);
    expect(runRawSql).not.toHaveBeenCalled();
  });

  it('rejects a non-integer --expect-count', async () => {
    await expect(
      makeProgram().parseAsync(['verify', 'truth', '--query', 'select count(*) from t', '--expect-count', 'abc', '--json'], { from: 'user' }),
    ).rejects.toThrow(/exit:/);
  });

  it('passes (exit 0) + records & flushes a finding when DB matches the claim', async () => {
    const oss = await import('../../lib/api/oss.js');
    (oss.runRawSql as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ n: 3 }] });
    await makeProgram().parseAsync(['verify', 'truth', '--query', 'select n', '--expect', '3', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(0);
    const { trackVerifyFinding, shutdownAnalytics } = await import('../../lib/analytics.js');
    expect(trackVerifyFinding).toHaveBeenCalledTimes(1);
    expect(shutdownAnalytics).toHaveBeenCalled();
  });

  it('flags false_pass (exit 1) when DB differs from the claim', async () => {
    const oss = await import('../../lib/api/oss.js');
    (oss.runRawSql as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [{ n: 1 }] });
    await makeProgram().parseAsync(['verify', 'truth', '--query', 'select n', '--expect', '3', '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
  });
});
