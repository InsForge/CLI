import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerProjectLinkCommand } from './link.js';

vi.mock('../../lib/skills.js', () => ({
  installSkills: vi.fn(async () => {}),
  reportCliUsage: vi.fn(async () => {}),
}));

vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  trackCommand: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

vi.mock('../../lib/api/platform.js', () => ({
  listOrganizations: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  getProjectApiKey: vi.fn(),
  reportAgentConnected: vi.fn(),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(),
}));

vi.mock('../../lib/config.js', () => ({
  getGlobalConfig: vi.fn(() => ({})),
  saveGlobalConfig: vi.fn(),
  saveProjectConfig: vi.fn(),
  getFrontendUrl: () => 'https://example.test',
  buildOssHost: vi.fn(),
  FAKE_PROJECT_ID: '00000000-0000-0000-0000-000000000000',
  FAKE_ORG_ID: '00000000-0000-0000-0000-000000000000',
}));

vi.mock('../../lib/output.js', () => ({
  outputJson: vi.fn(),
  outputSuccess: vi.fn(),
}));

vi.mock('../create.js', () => ({
  downloadGitHubTemplate: vi.fn(),
}));

vi.mock('../../auth-providers/apply.js', () => ({
  applyAuthProvider: vi.fn(),
  VALID_AUTH_PROVIDERS: ['better-auth'],
}));

vi.mock('../../lib/prompts.js', () => ({
  text: vi.fn(),
  select: vi.fn(),
  isCancel: () => false,
}));

vi.mock('@clack/prompts', () => ({
  spinner: () => ({ start: vi.fn(), message: vi.fn(), stop: vi.fn() }),
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  },
  note: vi.fn(),
}));

function buildProgram(): Command {
  const program = new Command().exitOverride();
  // Mirror the global flags the action handler reads via getRootOpts(cmd).
  program.option('--json').option('--api-url <url>');
  registerProjectLinkCommand(program);
  return program;
}

describe('project link: skills-only fast path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('with no args, installs skills and skips auth + project picker', async () => {
    const program = buildProgram();
    await program.parseAsync(['link'], { from: 'user' });

    const { installSkills, reportCliUsage } = await import('../../lib/skills.js');
    const { trackCommand } = await import('../../lib/analytics.js');
    const { requireAuth } = await import('../../lib/credentials.js');
    const { listOrganizations } = await import('../../lib/api/platform.js');

    expect(installSkills).toHaveBeenCalledWith(false, undefined);
    expect(trackCommand).toHaveBeenCalledWith('link', 'skills-only', { skills_only: true });
    expect(reportCliUsage).toHaveBeenCalledWith('cli.link_skills_only', true, 1);
    // Skills-only path must never trigger auth or the org picker.
    expect(requireAuth).not.toHaveBeenCalled();
    expect(listOrganizations).not.toHaveBeenCalled();
  });

  it('with --json, emits a single skills_only success payload', async () => {
    const program = buildProgram();
    await program.parseAsync(['link', '--json'], { from: 'user' });

    const { installSkills } = await import('../../lib/skills.js');
    const { outputJson } = await import('../../lib/output.js');

    expect(installSkills).toHaveBeenCalledWith(true, undefined);
    expect(outputJson).toHaveBeenCalledWith({ success: true, skills_only: true });
  });

  it('when installSkills throws, reports failure and exits non-zero', async () => {
    const { installSkills } = await import('../../lib/skills.js');
    (installSkills as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));

    const program = buildProgram();
    let exitCode: number | undefined;
    const origExit = process.exit;
    (process.exit as unknown) = (code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    };
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await program.parseAsync(['link'], { from: 'user' }).catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }

    const { reportCliUsage } = await import('../../lib/skills.js');
    expect(reportCliUsage).toHaveBeenCalledWith('cli.link_skills_only', false);
    expect(exitCode).toBe(1);
  });

  it('with --project-id, bypasses skills-only and falls through to auth path', async () => {
    const { requireAuth } = await import('../../lib/credentials.js');
    // Reject auth so we short-circuit without needing to mock the rest of the
    // OAuth flow — the assertion is just that the skills-only fast path was
    // skipped because --project-id was provided.
    (requireAuth as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('not authed'));

    const program = buildProgram();
    const origExit = process.exit;
    (process.exit as unknown) = (_code?: number) => {
      throw new Error('__exit__');
    };
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await program
        .parseAsync(['link', '--project-id', 'p1', '--json'], { from: 'user' })
        .catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }

    const { installSkills } = await import('../../lib/skills.js');
    expect(installSkills).not.toHaveBeenCalled();
    expect(requireAuth).toHaveBeenCalled();
  });
});
