import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('branch create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when no project linked', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as any).mockReturnValue(null);
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    let exitCode: number | undefined;
    const origExit = process.exit;
    (process.exit as any) = (code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    };
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as any;
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
    (getProjectConfig as any).mockReturnValue({
      project_id: 'p1',
      project_name: 'parent',
      org_id: 'o1',
    });
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchCreateCommand(program);
    let exitCode: number | undefined;
    const origExit = process.exit;
    (process.exit as any) = (code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    };
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as any;
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
    (getProjectConfig as any).mockReturnValue({
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
    (getProjectConfig as any).mockReturnValue({
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
});
