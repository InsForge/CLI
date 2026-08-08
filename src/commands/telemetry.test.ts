import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerTelemetryCommand } from './telemetry.js';

vi.mock('../lib/config.js', () => ({
  getGlobalConfig: vi.fn(),
  saveGlobalConfig: vi.fn(),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json');
  registerTelemetryCommand(program);
  return program;
}

async function run(argv: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await makeProgram().parseAsync(argv, { from: 'user' });
    return logSpy.mock.calls.flat().join('\n');
  } finally {
    logSpy.mockRestore();
  }
}

describe('telemetry command', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('INSFORGE_TELEMETRY_DISABLED', '');
    const { getGlobalConfig } = await import('../lib/config.js');
    (getGlobalConfig as Mock).mockReturnValue({ platform_api_url: 'https://api.insforge.dev' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('status reports enabled by default', async () => {
    const out = await run(['telemetry', 'status', '--json']);
    expect(JSON.parse(out)).toEqual({ enabled: true, source: 'default' });
  });

  it('status reports a config opt-out with its source', async () => {
    const { getGlobalConfig } = await import('../lib/config.js');
    (getGlobalConfig as Mock).mockReturnValue({
      platform_api_url: 'https://api.insforge.dev',
      telemetry_disabled: true,
    });
    const out = await run(['telemetry', 'status', '--json']);
    expect(JSON.parse(out)).toEqual({ enabled: false, source: 'config' });
  });

  it('status reports an env-var override', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    const out = await run(['telemetry', 'status', '--json']);
    expect(JSON.parse(out)).toEqual({ enabled: false, source: 'DO_NOT_TRACK' });
  });

  it('disable persists telemetry_disabled in the global config', async () => {
    const { saveGlobalConfig } = await import('../lib/config.js');
    await run(['telemetry', 'disable', '--json']);
    expect((saveGlobalConfig as Mock).mock.calls[0][0]).toMatchObject({ telemetry_disabled: true });
  });

  it('enable removes the flag from the global config', async () => {
    const { getGlobalConfig, saveGlobalConfig } = await import('../lib/config.js');
    (getGlobalConfig as Mock).mockReturnValue({
      platform_api_url: 'https://api.insforge.dev',
      telemetry_disabled: true,
    });
    await run(['telemetry', 'enable', '--json']);
    const saved = (saveGlobalConfig as Mock).mock.calls[0][0];
    expect('telemetry_disabled' in saved).toBe(false);
  });

  it('enable errors when an env var still forces telemetry off', async () => {
    vi.stubEnv('INSFORGE_TELEMETRY_DISABLED', '1');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      await expect(run(['telemetry', 'enable'])).rejects.toThrow('exit');
      expect(errSpy.mock.calls.flat().join('\n')).toContain('INSFORGE_TELEMETRY_DISABLED');
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
