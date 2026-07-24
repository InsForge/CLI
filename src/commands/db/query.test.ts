import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerDbCommands } from './query.js';

<<<<<<< HEAD
vi.mock('../../lib/api/oss.js', () => {
  const runRawSql = vi.fn();
  const isProvisioningError = vi.fn();
  const buildProvisioningErrorMessage = vi.fn((name?: string) =>
    name
      ? `Branch is still provisioning (this can take up to ~15 minutes). Branch: ${name}. Retry shortly, or create the branch with \`--wait-ready\` to block until it's usable.`
      : 'Branch is still provisioning (this can take up to ~15 minutes). Retry shortly, or create the branch with `--wait-ready` to block until it\'s usable.',
  );
  const handleBranchProvisioningError = vi.fn((err: unknown, json: boolean) => {
    if (isProvisioningError(err)) {
      const msg = buildProvisioningErrorMessage(undefined);
      console.error(json ? JSON.stringify({ error: msg, code: 'BRANCH_PROVISIONING' }) : `Error: ${msg}`);
      process.exit(1);
    }
  });
  return { runRawSql, isProvisioningError, buildProvisioningErrorMessage, handleBranchProvisioningError };
});
=======
vi.mock('../../lib/api/oss.js', () => ({
  runRawSql: vi.fn(),
  isProvisioningError: vi.fn(),
  buildProvisioningErrorMessage: vi.fn((name?: string) =>
    name
      ? `Branch is still provisioning (this can take up to ~12 minutes). Branch: ${name}. Retry shortly, or create the branch with \`--wait-ready\` to block until it's usable.`
      : 'Branch is still provisioning (this can take up to ~12 minutes). Retry shortly, or create the branch with `--wait-ready` to block until it\'s usable.',
  ),
}));
>>>>>>> 34b302ebc5c301be89edb5a9c7e75ac702eb55ca

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(),
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  trackCommand: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

vi.mock('../../lib/skills.js', () => ({
  reportCliUsage: vi.fn(async () => {}),
}));

vi.mock('../../lib/command-telemetry.js', () => ({
  trackCommandUsage: vi.fn(async () => {}),
}));

describe('db query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows friendly provisioning message when on a branch and network fails', async () => {
    const { runRawSql, isProvisioningError } = await import('../../lib/api/oss.js');
    (runRawSql as Mock).mockRejectedValue(new Error('fetch failed'));
    (isProvisioningError as Mock).mockReturnValue(true);
<<<<<<< HEAD
=======
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'b1',
      project_name: 'feat-x',
      org_id: 'o1',
      api_key: 'k',
      oss_host: 'host',
      branched_from: { project_id: 'p1', project_name: 'parent' },
    });
>>>>>>> 34b302ebc5c301be89edb5a9c7e75ac702eb55ca

    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerDbCommands(program);

<<<<<<< HEAD
    const state = { exitCode: undefined as number | undefined, errLogs: [] as string[] };
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      state.exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      state.errLogs.push(args.map(String).join(' '));
    };
=======
    const errLogs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      errLogs.push(args.map(String).join(' '));
    };
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
>>>>>>> 34b302ebc5c301be89edb5a9c7e75ac702eb55ca
    try {
      await program
        .parseAsync(['query', 'SELECT 1', '--json'], { from: 'user' })
        .catch(() => {});
    } finally {
<<<<<<< HEAD
      process.exit = origExit;
      console.error = origErr;
    }

    expect(state.exitCode).toBe(1);
    const errText = state.errLogs.join('\n');
    expect(errText).toContain('still provisioning');
=======
      console.error = origErr;
      process.exit = origExit;
    }

    expect(exitCode).toBe(1);
    const errText = errLogs.join('\n');
    expect(errText).toContain('still provisioning');
    expect(errText).toContain('feat-x');
>>>>>>> 34b302ebc5c301be89edb5a9c7e75ac702eb55ca
    expect(errText).toContain('--wait-ready');
  });

  it('shows generic error when provisioning error check returns false', async () => {
    const { runRawSql, isProvisioningError } = await import('../../lib/api/oss.js');
    (runRawSql as Mock).mockRejectedValue(new Error('fetch failed'));
    (isProvisioningError as Mock).mockReturnValue(false);
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'b1',
      project_name: 'feat-x',
      org_id: 'o1',
      branched_from: { project_id: 'p1', project_name: 'parent' },
    });

    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerDbCommands(program);

<<<<<<< HEAD
    const state = { exitCode: undefined as number | undefined, errLogs: [] as string[] };
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      state.exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      state.errLogs.push(args.map(String).join(' '));
    };
=======
    const errLogs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      errLogs.push(args.map(String).join(' '));
    };
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
>>>>>>> 34b302ebc5c301be89edb5a9c7e75ac702eb55ca
    try {
      await program
        .parseAsync(['query', 'SELECT 1', '--json'], { from: 'user' })
        .catch(() => {});
    } finally {
<<<<<<< HEAD
      process.exit = origExit;
      console.error = origErr;
    }

    expect(state.exitCode).toBe(1);
    const errText = state.errLogs.join('\n');
=======
      console.error = origErr;
      process.exit = origExit;
    }

    expect(exitCode).toBe(1);
    const errText = errLogs.join('\n');
    // Should contain the raw error, not the provisioning message
>>>>>>> 34b302ebc5c301be89edb5a9c7e75ac702eb55ca
    expect(errText).toContain('fetch failed');
    expect(errText).not.toContain('still provisioning');
  });
});
