import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerProjectManageCommands } from './manage.js';

vi.mock('../../lib/api/platform.js', () => ({
  getProject: vi.fn(),
  updateProject: vi.fn(async () => ({ id: 'proj-1', name: 'Acme' })),
  deleteProject: vi.fn(),
  transferProject: vi.fn(),
  restoreProject: vi.fn(),
  upgradeInstance: vi.fn(async () => ({
    message: 'Instance upgrade initiated',
    project: { id: 'proj-1', name: 'Acme' },
    previousVolumeSizeGiB: 16,
  })),
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

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(async () => true),
  isCancel: vi.fn(() => false),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>').option('-y, --yes');
  const projectsCmd = program.command('projects');
  registerProjectManageCommands(projectsCmd);
  return program;
}

describe('projects disk resizing', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errors: string[];
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = [];
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('update --storage-size refuses and points at upgrade-instance --volume-size', async () => {
    const { updateProject, upgradeInstance } = await import('../../lib/api/platform.js');
    await expect(
      makeProgram().parseAsync(['projects', 'update', '--storage-size', '20', '--json'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(updateProject).not.toHaveBeenCalled();
    expect(upgradeInstance).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('upgrade-instance --volume-size');
  });

  it('upgrade-instance --volume-size grows the disk without an instance type', async () => {
    const { upgradeInstance } = await import('../../lib/api/platform.js');
    await makeProgram().parseAsync(
      ['projects', 'upgrade-instance', '--volume-size', '20', '--json'],
      { from: 'user' },
    );
    expect(upgradeInstance).toHaveBeenCalledWith('proj-1', { volumeSizeGiB: 20 }, undefined);
  });

  it('upgrade-instance sends both instance type and volume size', async () => {
    const { upgradeInstance } = await import('../../lib/api/platform.js');
    await makeProgram().parseAsync(
      ['projects', 'upgrade-instance', 'large', '--volume-size', '40', '--json'],
      { from: 'user' },
    );
    expect(upgradeInstance).toHaveBeenCalledWith(
      'proj-1',
      { instanceType: 'large', volumeSizeGiB: 40 },
      undefined,
    );
  });

  it('upgrade-instance requires an instance type or --volume-size', async () => {
    const { upgradeInstance } = await import('../../lib/api/platform.js');
    await expect(
      makeProgram().parseAsync(['projects', 'upgrade-instance', '--json'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(upgradeInstance).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('--volume-size');
  });

  it.each(['4', '8.5'])('upgrade-instance rejects --volume-size %s', async (size) => {
    const { upgradeInstance } = await import('../../lib/api/platform.js');
    await expect(
      makeProgram().parseAsync(['projects', 'upgrade-instance', '--volume-size', size, '--json'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    expect(upgradeInstance).not.toHaveBeenCalled();
  });
});
