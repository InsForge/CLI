import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerOrgsManageCommands } from './manage.js';
import { CLIError } from '../../lib/errors.js';

vi.mock('../../lib/api/platform.js', () => ({
  createOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  listMembers: vi.fn(),
  inviteMember: vi.fn(),
  removeMember: vi.fn(),
  updateMemberRole: vi.fn(),
  leaveOrganization: vi.fn(async () => ({ message: 'Successfully left the organization' })),
  deleteOrganization: vi.fn(async () => ({
    message: 'Organization deleted successfully',
    organizationId: 'org-1',
  })),
  listOrganizations: vi.fn(async () => [
    { id: 'org-1', name: 'Acme', type: 'team', created_at: '', updated_at: '' },
  ]),
  listProjects: vi.fn(async () => []),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok' })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(),
}));

vi.mock('../../lib/resolve-org.js', () => ({
  resolveOrgId: vi.fn(async () => 'org-1'),
}));

vi.mock('../../lib/command-telemetry.js', () => ({
  trackCommandUsage: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>').option('-y, --yes');
  const orgsCmd = program.command('orgs');
  registerOrgsManageCommands(orgsCmd);
  return program;
}

async function runWithCapturedLog(program: Command, argv: string[]): Promise<string[]> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    logSpy.mockRestore();
  }
  return logs;
}

describe('orgs leave / delete', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errors: string[];
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    errors = [];
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('leave refuses to run without an explicit --org-id', async () => {
    const { leaveOrganization } = await import('../../lib/api/platform.js');
    await expect(
      runWithCapturedLog(makeProgram(), ['orgs', 'leave', '--json']),
    ).rejects.toThrow('process.exit');
    expect(leaveOrganization).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('--org-id');
  });

  it('leave --org-id --json leaves the org', async () => {
    const { leaveOrganization } = await import('../../lib/api/platform.js');
    const logs = await runWithCapturedLog(makeProgram(), [
      'orgs', 'leave', '--org-id', 'org-1', '--json',
    ]);
    expect(leaveOrganization).toHaveBeenCalledWith('org-1', undefined);
    expect(JSON.parse(logs.join('\n'))).toEqual({ left: true, org_id: 'org-1' });
  });

  it('leave surfaces the backend last-administrator error', async () => {
    const { leaveOrganization } = await import('../../lib/api/platform.js');
    (leaveOrganization as Mock).mockRejectedValueOnce(
      new CLIError('Cannot leave organization as the last administrator. Please transfer admin role to another member first'),
    );
    await expect(
      runWithCapturedLog(makeProgram(), ['orgs', 'leave', '--org-id', 'org-1', '--json']),
    ).rejects.toThrow('process.exit');
    expect(errors.join('\n')).toContain('last administrator');
  });

  it('delete refuses to run without an explicit --org-id', async () => {
    const { deleteOrganization } = await import('../../lib/api/platform.js');
    await expect(
      runWithCapturedLog(makeProgram(), ['orgs', 'delete', '--json']),
    ).rejects.toThrow('process.exit');
    expect(deleteOrganization).not.toHaveBeenCalled();
  });

  it('delete --org-id --json deletes the org', async () => {
    const { deleteOrganization } = await import('../../lib/api/platform.js');
    const logs = await runWithCapturedLog(makeProgram(), [
      'orgs', 'delete', '--org-id', 'org-1', '--json',
    ]);
    expect(deleteOrganization).toHaveBeenCalledWith('org-1', undefined);
    expect(JSON.parse(logs.join('\n'))).toEqual({ deleted: true, org_id: 'org-1' });
  });

  it('delete with --yes warns about the linked project after deleting its org', async () => {
    const { getProjectConfig } = await import('../../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'p1',
      project_name: 'my-app',
      org_id: 'org-1',
      appkey: 'k',
      region: 'us-east',
      api_key: 'key',
      oss_host: 'https://k.us-east.insforge.app',
    });
    const logs = await runWithCapturedLog(makeProgram(), [
      'orgs', 'delete', '--org-id', 'org-1', '--yes',
    ]);
    expect(logs.join('\n')).toContain('insforge link');
  });
});
