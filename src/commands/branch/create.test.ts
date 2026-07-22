import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerBranchCreateCommand } from './create.js';
import { CLIError } from '../../lib/errors.js';

vi.mock('../../lib/api/platform.js', () => ({
  createBranchApi: vi.fn(async (_parentId: string, body: { mode: string; name: string }) => ({
    id: 'branch-id',
    parent_project_id: 'p1',
    organization_id: 'o1',
    name: body.name,
    appkey: 'p1ky-x9p',
    region: 'us-east',
    branch_state: 'creating',
    branch_created_at: new Date().toISOString(),
    branch_metadata: { mode: body.mode },
  })),
  getBranchApi: vi.fn(async () => ({
    id: 'branch-id',
    parent_project_id: 'p1',
    organization_id: 'o1',
    name: 'feat-x',
    appkey: 'p1ky-x9p',
    region: 'us-east',
    branch_state: 'ready',
    branch_created_at: new Date().toISOString(),
    branch_metadata: { mode: 'full' },
  })),
  listBranchesApi: vi.fn(async () => []),
  NETWORK_ERROR_CODE: 'NETWORK_ERROR',
}));

// The data-plane readiness probe. It MUST be mocked: unmocked it makes a real
// request to a fake host and then polls for minutes.
vi.mock('../../lib/api/oss.js', () => ({
  probeBackendHealth: vi.fn(async () => ({ reachable: true, status: 200 })),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));

vi.mock('../../lib/config.js', () => ({
  buildOssHost: (appkey: string, region: string) => `https://${appkey}.${region}.insforge.app`,
  getProjectConfig: vi.fn(),
  saveProjectConfig: vi.fn(),
  getLocalConfigDir: () => '/tmp/.insforge',
  FAKE_PROJECT_ID: '00000000-0000-0000-0000-000000000000',
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  trackCommand: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

// Skip the auto-switch path in unit tests; switch.ts has its own coverage.
vi.mock('./switch.js', () => ({
  runBranchSwitch: vi.fn(async () => {}),
  registerBranchSwitchCommand: vi.fn(),
}));

// Capture spinner method calls so the non-JSON path can assert on them.
const spinnerMock = {
  start: vi.fn(),
  message: vi.fn(),
  stop: vi.fn(),
};
vi.mock('@clack/prompts', () => ({
  spinner: () => spinnerMock,
}));

// Run `fn` with process.exit + stderr captured, and always restore them. Returns
// the exit code fn triggered (undefined if it never exited). Timer/mock lifecycle
// stays with the caller — this only owns the exit/stderr swap.
async function withCapturedExit(fn: () => Promise<void>): Promise<number | undefined> {
  let exitCode: number | undefined;
  const origExit = process.exit;
  const origStderr = process.stderr.write.bind(process.stderr);
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error('__exit__');
  }) as typeof process.exit;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.exit = origExit;
    process.stderr.write = origStderr;
  }
  return exitCode;
}

describe('branch create', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    spinnerMock.start.mockReset();
    spinnerMock.message.mockReset();
    spinnerMock.stop.mockReset();
    // clearAllMocks clears CALLS but keeps implementations, so a test that made
    // the branch unreachable would otherwise leave every later test polling for
    // the full readiness budget.
    const { probeBackendHealth } = await import('../../lib/api/oss.js');
    (probeBackendHealth as Mock).mockResolvedValue({ reachable: true, status: 200 });
  });

  it('rejects when no project linked', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue(null);
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await program
        .parseAsync(['create', 'feat-x', '--mode', 'schema-only', '--no-switch', '--json'], {
          from: 'user',
        })
        .catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
    expect(exitCode).toBe(1);
  });

  it('rejects an invalid --mode value before any API call', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await program
        .parseAsync(['create', 'feat-x', '--mode', 'bogus', '--no-switch', '--json'], {
          from: 'user',
        })
        .catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
    const { createBranchApi } = await import('../../lib/api/platform.js');
    expect(createBranchApi).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });

  it('happy path with --json: posts then prints branch payload', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
      appkey: 'p1ky',
      region: 'us-east',
      api_key: 'k',
      oss_host: 'p1ky.us-east.insforge.app',
    });
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await program.parseAsync(
        ['create', 'feat-x', '--mode', 'schema-only', '--no-switch', '--json'],
        { from: 'user' },
      );
    } finally {
      console.log = origLog;
    }
    const { createBranchApi } = await import('../../lib/api/platform.js');
    expect(createBranchApi).toHaveBeenCalledWith(
      'p1',
      { mode: 'schema-only', name: 'feat-x' },
      undefined,
    );
    const out = logs.join('\n');
    expect(out).toContain('branch-id');
    expect(out).toContain('feat-x');
  });

  it('happy path without --no-switch invokes runBranchSwitch', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
      appkey: 'p1ky',
      region: 'us-east',
      api_key: 'k',
      oss_host: 'p1ky.us-east.insforge.app',
    });
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    try {
      await program.parseAsync(
        ['create', 'feat-x', '--mode', 'full', '--json'],
        { from: 'user' },
      );
    } finally {
      console.log = origLog;
    }
    const { runBranchSwitch } = await import('./switch.js');
    // In JSON mode, the auto-switch must be invoked silently so the create
    // command emits exactly one JSON document.
    expect(runBranchSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'feat-x', json: true, silent: true }),
    );
    // Single JSON payload, parseable as one document.
    expect(() => JSON.parse(logs.join('\n'))).not.toThrow();
  });

  it('switch failure after a successful create reports "switch failed", not "creation failed"', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
      appkey: 'p1ky',
      region: 'us-east',
      api_key: 'k',
      oss_host: 'https://p1ky.us-east.insforge.app',
    });
    const { runBranchSwitch } = await import('./switch.js');
    (runBranchSwitch as Mock).mockRejectedValueOnce(new Error('network down'));

    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await program
        .parseAsync(['create', 'feat-x', '--mode', 'full'], { from: 'user' })
        .catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
    expect(exitCode).toBe(1);
    // The crucial assertion: spinner stops with switch-failure copy, not
    // the misleading "creation failed" line.
    expect(spinnerMock.stop).toHaveBeenCalledTimes(1);
    const [stopMsg, stopCode] = spinnerMock.stop.mock.calls[0];
    expect(stopMsg).toContain('switching context failed');
    expect(stopMsg).toContain('insforge branch switch feat-x');
    expect(stopMsg).not.toContain('creation failed');
    expect(stopCode).toBe(1);
  });

  it('non-JSON path drives the spinner and keeps it active through switch', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
      appkey: 'p1ky',
      region: 'us-east',
      api_key: 'k',
      oss_host: 'https://p1ky.us-east.insforge.app',
    });
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    await program.parseAsync(['create', 'feat-x', '--mode', 'full'], { from: 'user' });

    // start fires once for the slow POST...
    expect(spinnerMock.start).toHaveBeenCalledTimes(1);
    expect(spinnerMock.start).toHaveBeenCalledWith(expect.stringContaining("Creating branch 'feat-x'"));
    // ...and stop fires exactly once (after the switch completes), with the
    // unified "ready and active" message — never with the misleading "ready"
    // line that a separate stop+restart pair would produce.
    expect(spinnerMock.stop).toHaveBeenCalledTimes(1);
    expect(spinnerMock.stop).toHaveBeenCalledWith(
      expect.stringContaining('ready and active'),
    );
    // Switch ran silently so its outputSuccess does not interleave with the
    // active spinner frame.
    const { runBranchSwitch } = await import('./switch.js');
    expect(runBranchSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'feat-x', json: false, silent: true }),
    );
  });
  it('does not report success while the branch host is not serving yet', async () => {
    // 'ready' is a control-plane state. Reporting success on it alone is what
    // makes the user's NEXT command fail against a host that resets.
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const { probeBackendHealth } = await import('../../lib/api/oss.js');
    (probeBackendHealth as Mock).mockResolvedValue({
      reachable: false,
      status: null,
      detail: 'Connection to p1ky-x9p.us-east.insforge.app was reset.',
    });
    vi.useFakeTimers();
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    const run = program
      .parseAsync(['create', 'feat-x', '--mode', 'schema-only', '--no-switch'], { from: 'user' })
      .catch(() => {});
    await vi.runAllTimersAsync();
    await run;
    vi.useRealTimers();
    const stopped = spinnerMock.stop.mock.calls.at(-1);
    expect(String(stopped?.[0])).toContain('not serving yet');
    expect(stopped?.[1]).toBe(1);
  });

  it('exits non-zero when the branch never finishes provisioning', async () => {
    // The sibling of "ready but not serving": if the branch is stuck in a
    // non-terminal state past the poll budget it is equally unusable, so
    // automation reading the exit code must not see success. (Review suggestion,
    // InsForge/CLI#201.)
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const { getBranchApi } = await import('../../lib/api/platform.js');
    const originalImpl = (getBranchApi as Mock).getMockImplementation();
    // Never reaches 'ready' — pollUntilReady exhausts its budget and returns the
    // last 'creating' snapshot.
    (getBranchApi as Mock).mockResolvedValue({
      id: 'branch-id',
      parent_project_id: 'p1',
      organization_id: 'o1',
      name: 'feat-x',
      appkey: 'p1ky-x9p',
      region: 'us-east',
      branch_state: 'creating',
      branch_created_at: new Date().toISOString(),
      branch_metadata: { mode: 'schema-only' },
    });
    let exitCode: number | undefined;
    vi.useFakeTimers();
    try {
      exitCode = await withCapturedExit(async () => {
        const program = new Command().exitOverride();
        program.option('--json').option('--api-url <url>').option('-y, --yes');
        registerBranchCreateCommand(program);
        const run = program
          .parseAsync(['create', 'feat-x', '--mode', 'schema-only', '--no-switch'], { from: 'user' })
          .catch(() => {});
        await vi.runAllTimersAsync();
        await run;
      });
    } finally {
      vi.useRealTimers();
      // Restore the shared 'ready' impl — clearAllMocks keeps implementations, so
      // leaving this 'creating' would make every later test poll the full budget.
      (getBranchApi as Mock).mockImplementation(originalImpl!);
    }
    expect(exitCode).toBe(1);
  });

  it('adopts a branch that was created despite a transport failure', async () => {
    // createBranchApi carries no idempotency key, so a reset on the RESPONSE
    // leg leaves a real, billing branch behind. Giving up here orphans it.
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const { createBranchApi, listBranchesApi } = await import('../../lib/api/platform.js');
    (createBranchApi as Mock).mockRejectedValueOnce(
      new CLIError('Connection to api.insforge.dev was reset.', 1, 'NETWORK_ERROR'),
    );
    (listBranchesApi as Mock).mockResolvedValueOnce([
      {
        id: 'branch-id',
        parent_project_id: 'p1',
        organization_id: 'o1',
        name: 'feat-x',
        appkey: 'p1ky-x9p',
        region: 'us-east',
        branch_state: 'creating',
        branch_created_at: new Date().toISOString(),
        branch_metadata: { mode: 'schema-only' },
      },
    ]);
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    await program
      .parseAsync(['create', 'feat-x', '--mode', 'schema-only', '--no-switch'], { from: 'user' })
      .catch(() => {});
    expect(listBranchesApi as Mock).toHaveBeenCalledWith('p1', undefined);
    // The run continued instead of exiting as a failed creation.
    expect(String(spinnerMock.stop.mock.calls.at(-1)?.[0])).not.toContain('creation failed');
  });

  it('does NOT adopt a same-name branch created with a DIFFERENT mode', async () => {
    // A collaborator's same-name branch landing in the skew window — at the same
    // moment our own request loses its response leg — must not be adopted, or a
    // default --switch would move local context onto their branch. Requiring a
    // matching mode narrows that collision. (cubic P2, InsForge/CLI#201.)
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const { createBranchApi, listBranchesApi } = await import('../../lib/api/platform.js');
    (createBranchApi as Mock).mockRejectedValueOnce(
      new CLIError('Connection to api.insforge.dev was reset.', 1, 'NETWORK_ERROR'),
    );
    // Same name, freshly created (inside the window), but the WRONG mode.
    (listBranchesApi as Mock).mockResolvedValueOnce([
      {
        id: 'someone-elses-branch',
        parent_project_id: 'p1',
        organization_id: 'o1',
        name: 'feat-x',
        appkey: 'p1ky-x9p',
        region: 'us-east',
        branch_state: 'creating',
        branch_created_at: new Date().toISOString(),
        branch_metadata: { mode: 'full' },
      },
    ]);
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    const exitCode = await withCapturedExit(() =>
      program
        .parseAsync(['create', 'feat-x', '--mode', 'schema-only', '--no-switch'], { from: 'user' })
        .catch(() => {})
    );
    // No adoption → the original transport error propagates → non-zero exit.
    expect(exitCode).toBe(1);
  });

  it('rethrows the original error when nothing was actually created', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const { createBranchApi, listBranchesApi } = await import('../../lib/api/platform.js');
    (createBranchApi as Mock).mockRejectedValueOnce(
      new CLIError('Connection to api.insforge.dev was reset.', 1, 'NETWORK_ERROR'),
    );
    (listBranchesApi as Mock).mockResolvedValueOnce([]);
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await program
        .parseAsync(['create', 'feat-x', '--mode', 'schema-only', '--no-switch'], { from: 'user' })
        .catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
    expect(exitCode).toBe(1);
  });
  it('does NOT adopt on an API rejection — a duplicate name is a refusal, not a lost response', async () => {
    // Adopting here would switch the caller into a pre-existing branch with a
    // different mode and different data. Only a transport failure is ambiguous.
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const { createBranchApi, listBranchesApi } = await import('../../lib/api/platform.js');
    (createBranchApi as Mock).mockRejectedValueOnce(
      new CLIError("Branch name 'feat-x' already exists on this parent", 1),
    );
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await program
        .parseAsync(['create', 'feat-x', '--mode', 'schema-only', '--no-switch'], { from: 'user' })
        .catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
    expect(listBranchesApi as Mock).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });

  it('does NOT adopt a branch that predates the request', async () => {
    // Same name, but it existed before we asked — so it is not ours.
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const { createBranchApi, listBranchesApi } = await import('../../lib/api/platform.js');
    (createBranchApi as Mock).mockRejectedValueOnce(
      new CLIError('Connection to api.insforge.dev was reset.', 1, 'NETWORK_ERROR'),
    );
    (listBranchesApi as Mock).mockResolvedValueOnce([
      {
        id: 'someone-elses',
        parent_project_id: 'p1',
        organization_id: 'o1',
        name: 'feat-x',
        appkey: 'p1ky-old',
        region: 'us-east',
        branch_state: 'ready',
        branch_created_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        branch_metadata: { mode: 'full' },
      },
    ]);
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await program
        .parseAsync(['create', 'feat-x', '--mode', 'schema-only', '--no-switch'], { from: 'user' })
        .catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
    expect(exitCode).toBe(1);
  });

  it('exits non-zero when the branch never serves, but still emits its identity first', async () => {
    // The branch exists and is billing: automation must be able to find and
    // delete it even though the command is failing.
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const { probeBackendHealth } = await import('../../lib/api/oss.js');
    (probeBackendHealth as Mock).mockResolvedValue({ reachable: false, status: null });
    const lines: string[] = [];
    const origLog = console.log;
    console.log = ((...args: unknown[]) => {
      lines.push(args.join(' '));
    }) as typeof console.log;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let exitCode: number | undefined;
    const origExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;
    vi.useFakeTimers();
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    try {
      const run = program
        .parseAsync(['create', 'feat-x', '--mode', 'schema-only', '--no-switch', '--json'], {
          from: 'user',
        })
        .catch(() => {});
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
      console.log = origLog;
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
    const payload = lines.join('\n');
    expect(payload).toContain('branch-id');
    expect(payload).toContain('"serving"');
    expect(payload).toContain('false');
    expect(exitCode).toBe(1);
  });
});
