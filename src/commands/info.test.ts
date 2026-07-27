import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerContextCommand } from './info.js';

const PROJECT_CONFIG = {
  project_id: 'p1',
  project_name: 'demo',
  org_id: 'o1',
  appkey: 'k',
  region: 'us-east',
  api_key: 'uak_secret_key',
  oss_host: 'http://localhost',
};

vi.mock('../lib/config.js', () => ({
  getCredentials: vi.fn(() => null),
  getGlobalConfig: vi.fn(() => ({})),
  getProjectConfig: vi.fn(),
}));
vi.mock('../lib/command-telemetry.js', () => ({
  trackTopLevelUsage: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>');
  registerContextCommand(program);
  return program;
}

async function runJson(argv: string[]): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await makeProgram().parseAsync(argv, { from: 'user' });
    return logSpy.mock.calls.flat().join('\n');
  } finally {
    logSpy.mockRestore();
  }
}

describe('current command', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { getProjectConfig } = await import('../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue(PROJECT_CONFIG);
  });

  it('redacts the privileged api_key from --json output', async () => {
    const output = await runJson(['current', '--json']);

    const payload = JSON.parse(output);
    expect(payload.project).toMatchObject({
      project_id: 'p1',
      project_name: 'demo',
      appkey: 'k',
      region: 'us-east',
      oss_host: 'http://localhost',
    });
    expect(payload.project).not.toHaveProperty('api_key');
    expect(output).not.toContain('uak_secret_key');
  });

  it('reports a null project in --json output when no project is linked', async () => {
    const { getProjectConfig } = await import('../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue(null);

    const payload = JSON.parse(await runJson(['current', '--json']));
    expect(payload.project).toBeNull();
  });
});
