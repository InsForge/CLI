import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerBranchCreateCommand } from './create.js';

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
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));

vi.mock('../../lib/config.js', () => ({
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

describe('branch create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spinnerMock.start.mockReset();
    spinnerMock.message.mockReset();
    spinnerMock.stop.mockReset();
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
});
