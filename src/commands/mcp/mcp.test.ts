import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerMcpCommands } from './index.js';

const project = {
  project_id: 'p1',
  project_name: 'demo',
  org_id: 'o1',
  appkey: 'app',
  region: 'us',
  api_key: 'secret',
  oss_host: 'https://app.us.insforge.app',
};

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => project),
}));

vi.mock('../../lib/api/oss.js', async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    updateMcpConnectionStatus: vi.fn(async () => {}),
  };
});

vi.mock('../../lib/skills.js', () => ({
  reportCliUsage: vi.fn(async () => {}),
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

let cwd: string;
const originalCwd = process.cwd();

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json');
  registerMcpCommands(program);
  return program;
}

async function run(argv: string[]) {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await makeProgram().parseAsync(argv, { from: 'user' });
  } finally {
    logSpy.mockRestore();
  }
}

describe('mcp commands', () => {
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'insforge-mcp-command-'));
    process.chdir(cwd);
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it('connect writes provider config and marks the backend connected', async () => {
    await run(['connect', 'cursor', '--json']);

    const config = JSON.parse(readFileSync(join(cwd, '.cursor/mcp.json'), 'utf-8'));
    expect(config.mcpServers.insforge.url).toBe('https://app.us.insforge.app/api/usage/mcp');

    const { updateMcpConnectionStatus } = await import('../../lib/api/oss.js');
    expect(updateMcpConnectionStatus).toHaveBeenCalledWith('connected');
  });

  it('disconnect removes a provider config and marks the backend disconnected', async () => {
    await run(['connect', 'cursor', '--json']);
    await run(['disconnect', 'cursor', '--json']);

    const config = JSON.parse(readFileSync(join(cwd, '.cursor/mcp.json'), 'utf-8'));
    expect(config.mcpServers.insforge).toBeUndefined();

    const { updateMcpConnectionStatus } = await import('../../lib/api/oss.js');
    expect(updateMcpConnectionStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('bare disconnect removes insforge from every supported local provider config', async () => {
    await run(['connect', 'cursor', '--json']);
    await run(['connect', 'claude-code', '--json']);

    await run(['disconnect', '--json']);

    const cursor = JSON.parse(readFileSync(join(cwd, '.cursor/mcp.json'), 'utf-8'));
    const claude = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8'));
    expect(cursor.mcpServers.insforge).toBeUndefined();
    expect(claude.mcpServers.insforge).toBeUndefined();
  });
});
