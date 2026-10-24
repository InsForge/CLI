import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerProjectManageCommands } from './manage.js';

vi.mock('../../lib/api/platform.js', () => ({
  getProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  transferProject: vi.fn(),
  restoreProject: vi.fn(),
  upgradeInstance: vi.fn(),
  restartProjectVersion: vi.fn(),
  getLatestInsforgeVersion: vi.fn(),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok' })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectId: vi.fn(() => 'proj-1'),
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>').option('-y, --yes');
  registerProjectManageCommands(program.command('projects'));
  return program;
}

describe('projects update --storage-size', () => {
  let errors: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses before login or any API call and points at support', async () => {
    const { updateProject } = await import('../../lib/api/platform.js');
    const { requireAuth } = await import('../../lib/credentials.js');
    await expect(
      makeProgram().parseAsync(['projects', 'update', '--storage-size', '20'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(requireAuth).not.toHaveBeenCalled();
    expect(updateProject).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('InsForge support');
  });
});
