import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const apiMock = vi.hoisted(() => ({
  startApifyCliFlow: vi.fn(),
  pollApifyConnection: vi.fn(),
  fetchApifyConnection: vi.fn(),
}));
const apifyConfigMock = vi.hoisted(() => ({
  storeApifyToken: vi.fn(),
}));
vi.mock('../../../lib/api/webscraper.js', () => ({ ...apiMock, ...apifyConfigMock }));

const configMock = vi.hoisted(() => ({
  getProjectConfig: vi.fn(() => ({ project_id: 'p1', project_name: 'Test Project' })),
  getAccessToken: vi.fn((): string | null => 'tok'),
}));
vi.mock('../../../lib/config.js', () => configMock);

const analyticsMock = vi.hoisted(() => ({
  trackGroupCommand: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));
vi.mock('../../../lib/analytics.js', () => analyticsMock);

const bridgeMock = vi.hoisted(() => ({
  runApifyAuthBridge: vi.fn(async () => ({ skillsInstalled: true })),
}));
vi.mock('../../../lib/apify-bridge.js', () => bridgeMock);

vi.mock('../../../lib/prompts.js', () => ({ isInteractive: false }));

// `open` is loaded dynamically inside runConnectFlow (OAuth path); mock so the
// real browser launch doesn't fire during tests.
vi.mock('open', () => ({ default: vi.fn() }));

// Silence interactive UI noise from clack — tests assert on mocks, not stdout.
vi.mock('@clack/prompts', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  };
});

const outputMock = vi.hoisted(() => ({
  outputJson: vi.fn(),
  outputSuccess: vi.fn(),
}));
vi.mock('../../../lib/output.js', () => outputMock);

// Imports must come AFTER the vi.mock calls because Vitest hoists the mocks
// but ESM module evaluation order still matters.
import { registerApifyConnectCommand } from './connect.js';
import { CLIError } from '../../../lib/errors.js';

interface RunResult {
  exitCode?: number;
}

// Override process.exit so handleError doesn't kill the test process; capture
// the first exit code. Mirrors src/commands/posthog/setup.test.ts.
async function runConnect(argv: string[]): Promise<RunResult> {
  const program = new Command();
  program.option('--json').option('--api-url <url>').option('-y, --yes');
  const webscraper = program.command('webscraper');
  const apify = webscraper.command('apify');
  registerApifyConnectCommand(apify);

  const origExit = process.exit;
  const result: RunResult = {};
  (process.exit as unknown) = (code?: number) => {
    if (result.exitCode === undefined) result.exitCode = code;
    throw new Error('__exit__');
  };
  try {
    await program
      .parseAsync(['node', 'test', 'webscraper', 'apify', 'connect', ...argv])
      .catch((err) => {
        if (err instanceof Error && err.message === '__exit__') return;
        throw err;
      });
  } finally {
    process.exit = origExit;
  }
  return result;
}

beforeEach(() => {
  apiMock.startApifyCliFlow.mockReset();
  apiMock.pollApifyConnection.mockReset();
  apiMock.fetchApifyConnection.mockReset();
  apifyConfigMock.storeApifyToken.mockReset();
  bridgeMock.runApifyAuthBridge.mockReset().mockResolvedValue({ skillsInstalled: true });
  outputMock.outputJson.mockReset();
  outputMock.outputSuccess.mockReset();
  analyticsMock.trackGroupCommand.mockReset();
  analyticsMock.shutdownAnalytics.mockClear();
  configMock.getProjectConfig.mockReturnValue({ project_id: 'p1', project_name: 'Test Project' });
  configMock.getAccessToken.mockReturnValue('tok');
});

describe('apify connect', () => {
  describe('--token path (self-hosted)', () => {
    it('stores the token and skips OAuth entirely', async () => {
      apifyConfigMock.storeApifyToken.mockResolvedValue({
        configured: true,
        maskedKey: 'apify_ap••••••••mnop',
      });

      await runConnect(['--token', 'apify_api_tok1234567890']);

      expect(apifyConfigMock.storeApifyToken).toHaveBeenCalledWith('apify_api_tok1234567890');
      expect(apiMock.startApifyCliFlow).not.toHaveBeenCalled();
      expect(apiMock.pollApifyConnection).not.toHaveBeenCalled();
      expect(apiMock.fetchApifyConnection).not.toHaveBeenCalled();
      expect(bridgeMock.runApifyAuthBridge).not.toHaveBeenCalled();
    });

    it('does not require a login token', async () => {
      configMock.getAccessToken.mockReturnValue(null);
      apifyConfigMock.storeApifyToken.mockResolvedValue({
        configured: true,
        maskedKey: 'apify_ap••••••••mnop',
      });

      const r = await runConnect(['--token', 'apify_api_tok1234567890']);

      expect(r.exitCode).toBeUndefined();
      expect(apifyConfigMock.storeApifyToken).toHaveBeenCalledOnce();
    });

    it('prints the masked key, never the raw token, in non-json mode', async () => {
      apifyConfigMock.storeApifyToken.mockResolvedValue({
        configured: true,
        maskedKey: 'apify_ap••••••••mnop',
      });

      await runConnect(['--token', 'apify_api_tok1234567890']);

      expect(outputMock.outputSuccess).toHaveBeenCalledWith(
        expect.stringContaining('apify_ap••••••••mnop'),
      );
      const allCalls = [...outputMock.outputSuccess.mock.calls, ...outputMock.outputJson.mock.calls];
      const serialized = JSON.stringify(allCalls);
      expect(serialized).not.toContain('apify_api_tok1234567890');
    });

    it('emits the masked token status in --json mode', async () => {
      apifyConfigMock.storeApifyToken.mockResolvedValue({
        configured: true,
        maskedKey: 'apify_ap••••••••mnop',
      });

      await runConnect(['--json', '--token', 'apify_api_tok1234567890']);

      expect(outputMock.outputJson).toHaveBeenCalledOnce();
      const payload = outputMock.outputJson.mock.calls[0][0] as {
        success: boolean;
        connectionState: string;
        token: { configured: boolean; maskedKey: string | null };
      };
      expect(payload.success).toBe(true);
      expect(payload.connectionState).toBe('newly-connected');
      expect(payload.token).toEqual({ configured: true, maskedKey: 'apify_ap••••••••mnop' });
    });

    it('propagates a rejected token as a CLI error and exits non-zero', async () => {
      apifyConfigMock.storeApifyToken.mockRejectedValue(
        new CLIError('Apify rejected this API token.', 1, 'INVALID_INPUT', 400),
      );

      const r = await runConnect(['--token', 'bogus']);

      expect(r.exitCode).toBe(1);
    });

    it('rejects an empty --token locally instead of falling through to OAuth', async () => {
      const r = await runConnect(['--token', '']);

      expect(r.exitCode).toBe(1);
      expect(apifyConfigMock.storeApifyToken).not.toHaveBeenCalled();
      expect(apiMock.startApifyCliFlow).not.toHaveBeenCalled();
      expect(apiMock.pollApifyConnection).not.toHaveBeenCalled();
      expect(apiMock.fetchApifyConnection).not.toHaveBeenCalled();
      expect(bridgeMock.runApifyAuthBridge).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only --token locally instead of falling through to OAuth', async () => {
      const r = await runConnect(['--token', '   ']);

      expect(r.exitCode).toBe(1);
      expect(apifyConfigMock.storeApifyToken).not.toHaveBeenCalled();
      expect(apiMock.startApifyCliFlow).not.toHaveBeenCalled();
      expect(bridgeMock.runApifyAuthBridge).not.toHaveBeenCalled();
    });
  });

  describe('OAuth path (--token absent) is unchanged', () => {
    it('fast path: cli-start says connected → verifies via /connection, skips polling, runs the auth bridge', async () => {
      apiMock.startApifyCliFlow.mockResolvedValue({ type: 'connected' });
      apiMock.fetchApifyConnection.mockResolvedValue({
        kind: 'connected',
        connection: { apifyUsername: 'someone', plan: 'free', status: 'active' },
      });

      await runConnect(['--skip-browser']);

      expect(apiMock.startApifyCliFlow).toHaveBeenCalledOnce();
      expect(apiMock.fetchApifyConnection).toHaveBeenCalledOnce();
      expect(apiMock.pollApifyConnection).not.toHaveBeenCalled();
      expect(bridgeMock.runApifyAuthBridge).toHaveBeenCalledOnce();
      expect(apifyConfigMock.storeApifyToken).not.toHaveBeenCalled();
    });

    it('slow path: cli-start returns authorizeUrl → polls until connected', async () => {
      apiMock.startApifyCliFlow.mockResolvedValue({
        type: 'authorize',
        authorizeUrl: 'https://example.com/auth',
      });
      apiMock.pollApifyConnection.mockResolvedValue({
        apifyUsername: 'someone',
        plan: 'free',
        status: 'active',
      });

      await runConnect(['--skip-browser']);

      expect(apiMock.pollApifyConnection).toHaveBeenCalledOnce();
      expect(apiMock.fetchApifyConnection).not.toHaveBeenCalled();
      expect(apifyConfigMock.storeApifyToken).not.toHaveBeenCalled();
    });

    it('still requires a login token, exactly as before', async () => {
      configMock.getAccessToken.mockReturnValue(null);
      apiMock.startApifyCliFlow.mockResolvedValue({ type: 'connected' });

      const r = await runConnect(['--skip-browser']);

      expect(r.exitCode).toBeGreaterThan(0);
      expect(apiMock.startApifyCliFlow).not.toHaveBeenCalled();
    });

    it('emits JSON with connectionState and connection, no token field', async () => {
      apiMock.startApifyCliFlow.mockResolvedValue({ type: 'connected' });
      apiMock.fetchApifyConnection.mockResolvedValue({
        kind: 'connected',
        connection: { apifyUsername: 'someone', plan: 'free', status: 'active' },
      });

      await runConnect(['--json', '--skip-browser']);

      expect(outputMock.outputJson).toHaveBeenCalledOnce();
      const payload = outputMock.outputJson.mock.calls[0][0] as {
        success: boolean;
        connectionState: string;
        connection: unknown;
        token?: unknown;
      };
      expect(payload.success).toBe(true);
      expect(payload.connectionState).toBe('already-connected');
      expect(payload.connection).toMatchObject({ apifyUsername: 'someone', plan: 'free' });
      expect(payload.token).toBeUndefined();
    });
  });
});
