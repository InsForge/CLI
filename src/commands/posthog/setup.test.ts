import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import type { SpawnSyncReturns } from 'node:child_process';

// Hoisted mocks — vi.mock factories are hoisted above ordinary top-level
// statements, so any const they reference must be hoisted via vi.hoisted.
const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const apiMock = vi.hoisted(() => ({
  startPosthogCliFlow: vi.fn(),
  pollPosthogConnection: vi.fn(),
  fetchPosthogConnection: vi.fn(),
}));
vi.mock('../../lib/api/posthog.js', () => apiMock);

const configMock = vi.hoisted(() => ({
  getProjectConfig: vi.fn(() => ({ project_id: 'p1', project_name: 'Test Project' })),
  getAccessToken: vi.fn(() => 'tok'),
}));
vi.mock('../../lib/config.js', () => configMock);

vi.mock('../../lib/prompts.js', () => ({ isInteractive: false }));

// `open` is loaded dynamically inside runConnectFlow; mock the module so the
// real browser launch doesn't fire during tests.
vi.mock('open', () => ({ default: vi.fn() }));

// Silence interactive UI noise from clack — tests assert on mocks, not stdout.
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  };
});

const outputMock = vi.hoisted(() => ({
  outputJson: vi.fn(),
  outputInfo: vi.fn(),
  outputSuccess: vi.fn(),
}));
vi.mock('../../lib/output.js', () => outputMock);

// Imports must come AFTER the vi.mock calls because Vitest hoists the mocks
// but ESM module evaluation order still matters.
import { registerPosthogSetupCommand } from './setup.js';

function spawnOk(): SpawnSyncReturns<string> {
  return { pid: 1, output: ['', '', ''], stdout: '', stderr: '', status: 0, signal: null };
}

function spawnExit(code: number): SpawnSyncReturns<string> {
  return { pid: 1, output: ['', '', ''], stdout: '', stderr: '', status: code, signal: null };
}

function spawnSignal(signal: NodeJS.Signals): SpawnSyncReturns<string> {
  // When killed by signal, Node sets status: null and exposes the signal name.
  return {
    pid: 1,
    output: ['', '', ''],
    stdout: '',
    stderr: '',
    status: null as unknown as number,
    signal,
  };
}

function spawnSpawnError(err: Error): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: ['', '', ''],
    stdout: '',
    stderr: '',
    status: null as unknown as number,
    signal: null,
    error: err,
  };
}

interface RunResult {
  exitCode?: number;
}

// Set up a Command tree with the global --json / --api-url flags the real
// program defines, then run `posthog setup` against it. Override process.exit
// so handleError doesn't kill the test process; capture the first exit code.
async function runSetup(argv: string[]): Promise<RunResult> {
  const program = new Command();
  program.option('--json').option('--api-url <url>').option('-y, --yes');
  const posthog = program.command('posthog');
  registerPosthogSetupCommand(posthog);

  const origExit = process.exit;
  const result: RunResult = {};
  (process.exit as unknown) = (code?: number) => {
    if (result.exitCode === undefined) result.exitCode = code;
    throw new Error('__exit__');
  };
  try {
    await program.parseAsync(['node', 'test', 'posthog', 'setup', ...argv]).catch((err) => {
      if (err instanceof Error && err.message === '__exit__') return;
      throw err;
    });
  } finally {
    process.exit = origExit;
  }
  return result;
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  apiMock.startPosthogCliFlow.mockReset();
  apiMock.pollPosthogConnection.mockReset();
  apiMock.fetchPosthogConnection.mockReset();
  outputMock.outputJson.mockReset();
  outputMock.outputInfo.mockReset();
  outputMock.outputSuccess.mockReset();
  configMock.getProjectConfig.mockReturnValue({ project_id: 'p1', project_name: 'Test Project' });
  configMock.getAccessToken.mockReturnValue('tok');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('posthog setup', () => {
  describe('ensureDashboardConnection', () => {
    it('fast path: cli-start says connected → verifies via /connection, skips polling', async () => {
      apiMock.startPosthogCliFlow.mockResolvedValue({ type: 'connected' });
      apiMock.fetchPosthogConnection.mockResolvedValue({
        kind: 'connected',
        connection: { apiKey: 'phc_', host: 'h', posthogProjectId: '1' },
      });
      spawnSyncMock.mockReturnValue(spawnOk());

      await runSetup(['--skip-browser']);

      expect(apiMock.startPosthogCliFlow).toHaveBeenCalledOnce();
      expect(apiMock.fetchPosthogConnection).toHaveBeenCalledOnce();
      expect(apiMock.pollPosthogConnection).not.toHaveBeenCalled();
    });

    it('OAuth path: cli-start returns authorizeUrl → polls until connected', async () => {
      apiMock.startPosthogCliFlow.mockResolvedValue({
        type: 'authorize',
        authorizeUrl: 'https://example.com/auth',
      });
      apiMock.pollPosthogConnection.mockResolvedValue({
        apiKey: 'phc_',
        host: 'h',
        posthogProjectId: '1',
      });
      spawnSyncMock.mockReturnValue(spawnOk());

      await runSetup(['--skip-browser']);

      expect(apiMock.pollPosthogConnection).toHaveBeenCalledOnce();
      expect(apiMock.fetchPosthogConnection).not.toHaveBeenCalled();
    });

    it('fast-path data-drift: cli-start says connected but /connection says no → exits, wizard never spawns', async () => {
      apiMock.startPosthogCliFlow.mockResolvedValue({ type: 'connected' });
      apiMock.fetchPosthogConnection.mockResolvedValue({ kind: 'not-connected' });

      const r = await runSetup(['--skip-browser']);

      expect(r.exitCode).toBeGreaterThan(0);
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });

  describe('wizard step', () => {
    beforeEach(() => {
      apiMock.startPosthogCliFlow.mockResolvedValue({ type: 'connected' });
      apiMock.fetchPosthogConnection.mockResolvedValue({
        kind: 'connected',
        connection: { apiKey: 'phc_', host: 'h', posthogProjectId: '1' },
      });
    });

    it('spawn error (ENOENT) → exits non-zero', async () => {
      const enoent = Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' });
      spawnSyncMock.mockReturnValue(spawnSpawnError(enoent));

      const r = await runSetup(['--skip-browser']);

      expect(spawnSyncMock).toHaveBeenCalledOnce();
      expect(r.exitCode).toBeGreaterThan(0);
    });

    it('non-zero exit → exits non-zero', async () => {
      spawnSyncMock.mockReturnValue(spawnExit(1));

      const r = await runSetup(['--skip-browser']);

      expect(r.exitCode).toBeGreaterThan(0);
    });

    it('SIGINT (exit 130) → clean exit, no error thrown', async () => {
      spawnSyncMock.mockReturnValue(spawnExit(130));

      const r = await runSetup(['--skip-browser']);

      // Cancellation is graceful — runSetup returns normally, no handleError
      // path, so process.exit was never called by the CLI.
      expect(r.exitCode).toBeUndefined();
    });

    it('SIGINT signal (status=null, signal=SIGINT) → clean exit', async () => {
      spawnSyncMock.mockReturnValue(spawnSignal('SIGINT'));

      const r = await runSetup(['--skip-browser']);

      expect(r.exitCode).toBeUndefined();
    });

    it('uses platform-aware npx binary', async () => {
      spawnSyncMock.mockReturnValue(spawnOk());

      await runSetup(['--skip-browser']);

      const [bin, args] = spawnSyncMock.mock.calls[0];
      expect(bin).toMatch(/^npx(\.cmd)?$/);
      expect(args).toEqual(['-y', '@posthog/wizard@latest']);
    });
  });

  describe('--json mode', () => {
    it('skips wizard, emits JSON with wizardCommand', async () => {
      apiMock.startPosthogCliFlow.mockResolvedValue({ type: 'connected' });
      apiMock.fetchPosthogConnection.mockResolvedValue({
        kind: 'connected',
        connection: { apiKey: 'phc_', host: 'h', posthogProjectId: '1' },
      });

      await runSetup(['--skip-browser']);
      spawnSyncMock.mockClear();

      // re-run in JSON mode
      const program = new Command();
      program.option('--json').option('--api-url <url>').option('-y, --yes');
      const posthog = program.command('posthog');
      registerPosthogSetupCommand(posthog);
      await program.parseAsync(['node', 'test', '--json', 'posthog', 'setup', '--skip-browser']);

      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(outputMock.outputJson).toHaveBeenCalledOnce();
      const payload = outputMock.outputJson.mock.calls[0][0] as {
        success: boolean;
        wizardSkipped: boolean;
        wizardCommand: string;
      };
      expect(payload.success).toBe(true);
      expect(payload.wizardSkipped).toBe(true);
      expect(payload.wizardCommand).toMatch(/^npx(\.cmd)? -y @posthog\/wizard@latest$/);
    });
  });
});
