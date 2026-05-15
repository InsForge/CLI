import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

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

// `open` is loaded dynamically inside runConnectFlow; mock so the real browser
// launch doesn't fire during tests.
vi.mock('open', () => ({ default: vi.fn() }));

// Silence interactive UI noise from clack — tests assert on mocks, not stdout.
const clackNoteMock = vi.hoisted(() => vi.fn());
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    note: clackNoteMock,
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  };
});

const outputMock = vi.hoisted(() => ({
  outputJson: vi.fn(),
  outputSuccess: vi.fn(),
}));
vi.mock('../../lib/output.js', () => outputMock);

// Imports must come AFTER the vi.mock calls because Vitest hoists the mocks
// but ESM module evaluation order still matters.
import { registerPosthogSetupCommand } from './setup.js';

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
  apiMock.startPosthogCliFlow.mockReset();
  apiMock.pollPosthogConnection.mockReset();
  apiMock.fetchPosthogConnection.mockReset();
  outputMock.outputJson.mockReset();
  outputMock.outputSuccess.mockReset();
  clackNoteMock.mockReset();
  configMock.getProjectConfig.mockReturnValue({ project_id: 'p1', project_name: 'Test Project' });
  configMock.getAccessToken.mockReturnValue('tok');
});

describe('posthog setup', () => {
  describe('ensureDashboardConnection', () => {
    it('fast path: cli-start says connected → verifies via /connection, skips polling', async () => {
      apiMock.startPosthogCliFlow.mockResolvedValue({ type: 'connected' });
      apiMock.fetchPosthogConnection.mockResolvedValue({
        kind: 'connected',
        connection: { apiKey: 'phc_', host: 'h', posthogProjectId: '1' },
      });

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

      await runSetup(['--skip-browser']);

      expect(apiMock.pollPosthogConnection).toHaveBeenCalledOnce();
      expect(apiMock.fetchPosthogConnection).not.toHaveBeenCalled();
    });

    it('fast-path data-drift: cli-start says connected but /connection says no → exits non-zero', async () => {
      apiMock.startPosthogCliFlow.mockResolvedValue({ type: 'connected' });
      apiMock.fetchPosthogConnection.mockResolvedValue({ kind: 'not-connected' });

      const r = await runSetup(['--skip-browser']);

      expect(r.exitCode).toBeGreaterThan(0);
      expect(clackNoteMock).not.toHaveBeenCalled();
    });
  });

  describe('wizard handoff', () => {
    beforeEach(() => {
      apiMock.startPosthogCliFlow.mockResolvedValue({ type: 'connected' });
      apiMock.fetchPosthogConnection.mockResolvedValue({
        kind: 'connected',
        connection: { apiKey: 'phc_', host: 'h', posthogProjectId: '1' },
      });
    });

    it('always prints the wizard command in a Next step note (no spawn, no TTY check)', async () => {
      await runSetup(['--skip-browser']);

      expect(clackNoteMock).toHaveBeenCalledOnce();
      const [body, title] = clackNoteMock.mock.calls[0];
      expect(title).toBe('Next step');
      expect(body).toMatch(/npx(\.cmd)? -y @posthog\/wizard@latest/);
    });
  });

  describe('--json mode', () => {
    it('emits JSON with wizardSkipped=true and wizardCommand', async () => {
      apiMock.startPosthogCliFlow.mockResolvedValue({ type: 'connected' });
      apiMock.fetchPosthogConnection.mockResolvedValue({
        kind: 'connected',
        connection: { apiKey: 'phc_', host: 'h', posthogProjectId: '1' },
      });

      const program = new Command();
      program.option('--json').option('--api-url <url>').option('-y, --yes');
      const posthog = program.command('posthog');
      registerPosthogSetupCommand(posthog);
      await program.parseAsync(['node', 'test', '--json', 'posthog', 'setup', '--skip-browser']);

      // No clack note in JSON mode (stdout stays clean for piped consumers).
      expect(clackNoteMock).not.toHaveBeenCalled();
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
