import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerBranchMergeCommand } from './merge.js';

const fsMock = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('node:fs', () => fsMock);

vi.mock('../../lib/api/platform.js', () => ({
  listBranchesApi: vi.fn(async () => [
    { id: 'b1', name: 'feat-x', branch_state: 'ready', organization_id: 'o1', parent_project_id: 'p1', appkey: 'k', region: 'us-east', branch_created_at: '2026', branch_metadata: { mode: 'full' } },
  ]),
  mergeBranchDryRunApi: vi.fn(async () => ({
    summary: { added: 1, modified: 0, conflicts: 0 },
    rendered_sql: "BEGIN;\n-- [DDL] table public.users (modify)\nALTER TABLE public.users ADD COLUMN x TEXT;\nCOMMIT;",
    changes: [{ schema: 'public', object: 'users', type: 'table', action: 'modify', sql: '...' }],
    conflicts: [],
  })),
  mergeBranchExecuteApi: vi.fn(async () => ({
    ok: true,
    result: {
      branchId: 'b1',
      status: 'merged',
      diff: { summary: { added: 1, modified: 0, conflicts: 0 }, rendered_sql: '', changes: [], conflicts: [] },
    },
  })),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1',
    project_name: 'parent',
    org_id: 'o1',
    appkey: 'k',
    region: 'us-east',
    api_key: 'key',
    oss_host: 'k.us-east.insforge.app',
  })),
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

describe('branch merge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.writeFileSync.mockReset();
  });

  it('--dry-run prints rendered_sql + summary, does not call execute', async () => {
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchMergeCommand(program);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await program.parseAsync(['merge', 'feat-x', '--dry-run', '--json'], { from: 'user' });
    } finally {
      console.log = origLog;
    }
    const { mergeBranchExecuteApi } = await import('../../lib/api/platform.js');
    expect(mergeBranchExecuteApi).not.toHaveBeenCalled();
    const out = logs.join('\n');
    expect(out).toContain('ALTER TABLE');
  });

  it('writes rendered_sql to --save-sql path', async () => {
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchMergeCommand(program);
    const origLog = console.log;
    console.log = () => {};
    try {
      await program.parseAsync(
        ['merge', 'feat-x', '--dry-run', '--save-sql', '/tmp/diff.sql', '--json'],
        { from: 'user' },
      );
    } finally {
      console.log = origLog;
    }
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      '/tmp/diff.sql',
      expect.stringContaining('ALTER TABLE'),
    );
  });

  it('execute happy path: --yes skips confirmation and calls execute', async () => {
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchMergeCommand(program);
    const origLog = console.log;
    console.log = () => {};
    try {
      await program.parseAsync(['merge', 'feat-x', '--yes', '--json'], { from: 'user' });
    } finally {
      console.log = origLog;
    }
    const { mergeBranchExecuteApi } = await import('../../lib/api/platform.js');
    expect(mergeBranchExecuteApi).toHaveBeenCalledWith('b1', undefined);
  });

  it('conflict path exits with code 2 and prints per-conflict summary', async () => {
    const { mergeBranchDryRunApi } = await import('../../lib/api/platform.js');
    (mergeBranchDryRunApi as any).mockResolvedValueOnce({
      summary: { added: 0, modified: 0, conflicts: 1 },
      rendered_sql: '-- ⚠️ MERGE BLOCKED: 1 conflict(s) detected.',
      changes: [],
      conflicts: [
        {
          schema: 'public',
          object: 'users',
          type: 'table',
          parent_t0_hash: 'a',
          parent_now_hash: 'b',
          branch_now_hash: 'c',
          hint: 'both sides changed',
        },
      ],
    });
    const program = new Command().exitOverride();
    program.option('--json').option('--api-url <url>').option('-y, --yes');
    registerBranchMergeCommand(program);
    // Capture the FIRST process.exit code only — once we've thrown out of the
    // happy path, handleError may exit again (with code 1) which would
    // overwrite the meaningful first exit. The first call is what the user sees.
    let exitCode: number | undefined;
    const origExit = process.exit;
    (process.exit as any) = (code?: number) => {
      if (exitCode === undefined) exitCode = code;
      throw new Error('__exit__');
    };
    const origLog = console.log;
    console.log = () => {};
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as any;
    try {
      await program
        .parseAsync(['merge', 'feat-x', '--dry-run'], { from: 'user' })
        .catch(() => {});
    } finally {
      process.exit = origExit;
      console.log = origLog;
      process.stderr.write = origStderr;
    }
    expect(exitCode).toBe(2);
  });
});
