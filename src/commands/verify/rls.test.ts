import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type * as VerifyProbe from '../../lib/verify-probe.js';
import { registerVerifyRlsCommand } from './rls.js';

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1', project_name: 'n', org_id: 'o1', region: 'us-east',
    api_key: 'key', oss_host: 'https://h',
  })),
}));
vi.mock('../../lib/api/oss.js', () => ({
  getAnonKey: vi.fn(async () => 'anon'),
  runRawSql: vi.fn(async () => ({ rows: [{ id: 'aid' }] })),
}));
vi.mock('../../lib/analytics.js', () => ({
  trackVerifyFinding: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));
// Keep the pure helpers (classifyRls / isSafeIdentifier / isLikelyEmail) real; mock the
// two network calls.
vi.mock('../../lib/verify-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof VerifyProbe>();
  return { ...actual, login: vi.fn(async () => 'token'), recordsCount: vi.fn(async () => 0) };
});

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json');
  registerVerifyRlsCommand(program.command('verify'));
  return program;
}

describe('verify rls (command)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
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

  it('rejects an --owner that smuggles PostgREST params, before any login', async () => {
    const { login } = await import('../../lib/verify-probe.js');
    await expect(
      makeProgram().parseAsync(['verify', 'rls', '--table', 'orders', '--owner', 'user_id&select=secret', '--json'], { from: 'user' }),
    ).rejects.toThrow(/exit:/);
    expect(login).not.toHaveBeenCalled();
  });

  it('rejects a non-email --user-a, before any login', async () => {
    const { login } = await import('../../lib/verify-probe.js');
    await expect(
      makeProgram().parseAsync(['verify', 'rls', '--table', 'orders', '--owner', 'user_id', '--user-a', 'not-an-email', '--json'], { from: 'user' }),
    ).rejects.toThrow(/exit:/);
    expect(login).not.toHaveBeenCalled();
  });

  it('scopes the anonymous control to A\'s owner filter (not the whole table)', async () => {
    const { recordsCount } = await import('../../lib/verify-probe.js');
    await makeProgram().parseAsync(['verify', 'rls', '--table', 'orders', '--owner', 'user_id', '--json'], { from: 'user' });
    // 3 probes: B-of-A, A-own, anon — all must use the same owner-scoped filter.
    expect(recordsCount).toHaveBeenCalledTimes(3);
    // The anon probe (3rd call) must pass the filter + no token, NOT undefined for the filter.
    expect(recordsCount).toHaveBeenNthCalledWith(
      3, 'https://h', 'orders', expect.stringContaining('user_id=eq.'), undefined, 'anon',
    );
  });
});
