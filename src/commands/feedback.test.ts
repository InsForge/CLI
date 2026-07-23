import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerFeedbackCommand } from './feedback.js';
import { resetTelemetryOutcomeForTests } from '../lib/command-telemetry.js';

vi.mock('../lib/api/feedback.js', () => ({
  submitFeedback: vi.fn(async () => ({ id: 'fb_123', status: 'received' })),
}));
vi.mock('../lib/config.js', () => ({
  FAKE_PROJECT_ID: 'fa4e0000-1234-5678-90ab-cd1234567890',
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1',
    project_name: 'demo',
    org_id: 'o1',
    appkey: 'k',
    region: 'us-east',
    api_key: 'key',
    oss_host: 'http://localhost',
  })),
}));
vi.mock('../lib/analytics.js', () => ({
  trackGroupCommand: vi.fn(),
  trackTopLevelCommand: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>');
  registerFeedbackCommand(program);
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

describe('feedback command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTelemetryOutcomeForTests();
  });

  it('submits a structured payload with auto-attached context', async () => {
    const { submitFeedback } = await import('../lib/api/feedback.js');

    await run([
      'feedback',
      '--type', 'bug',
      '--component', 'backend',
      '--title', 'db policies create 500s on uppercase table names',
      '--detail', 'Creating an RLS policy on table "Users" returns 500. Lowercase names work.',
      '--area', 'db',
      '--command', 'insforge db policies create ...',
      '--severity', 'major',
    ]);

    const [payload] = (submitFeedback as Mock).mock.calls[0];
    expect(payload).toMatchObject({
      type: 'bug',
      component: 'backend',
      severity: 'major',
      area: 'db',
      project_id: 'p1',
      org_id: 'o1',
      region: 'us-east',
    });
    expect(payload.client_info).toMatchObject({
      source: 'cli',
      node_version: process.version,
    });
    expect(payload.client_info.os).toContain(process.platform);
  });

  it('redacts PII from free-text fields before sending', async () => {
    const { submitFeedback } = await import('../lib/api/feedback.js');

    await run([
      'feedback',
      '--type', 'bug',
      '--component', 'backend',
      '--title', 'auth fails for jane@example.com',
      '--detail', 'Login with key uak_a1b2c3d4e5f6 under /Users/jane/app fails.',
      '--error', 'Error: invalid token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc123def456',
    ]);

    const [payload] = (submitFeedback as Mock).mock.calls[0];
    expect(payload.title).toBe('auth fails for [REDACTED_EMAIL]');
    expect(payload.detail).toBe('Login with key [REDACTED_KEY] under ~/app fails.');
    expect(payload.error).toContain('[REDACTED_JWT]');
    expect(JSON.stringify(payload)).not.toContain('jane');
  });

  it('rejects a missing type in non-interactive mode with a usage hint', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      await expect(
        run(['feedback', '--component', 'cli', '--title', 't', '--detail', 'd']),
      ).rejects.toThrow('exit');
      expect(errSpy.mock.calls.flat().join('\n')).toContain('--type is required');
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('rejects a missing component in non-interactive mode with a usage hint', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      await expect(
        run(['feedback', '--type', 'bug', '--title', 't', '--detail', 'd']),
      ).rejects.toThrow('exit');
      const output = errSpy.mock.calls.flat().join('\n');
      expect(output).toContain('--component is required');
      expect(output).toContain('backend, sdk, cli, skills, docs, other');
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('requires --language for SDK feedback and passes it through lowercased', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      await expect(
        run(['feedback', '--type', 'bug', '--component', 'sdk', '--title', 't', '--detail', 'd']),
      ).rejects.toThrow('exit');
      expect(errSpy.mock.calls.flat().join('\n')).toContain('--language is required for SDK feedback');
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }

    const { submitFeedback } = await import('../lib/api/feedback.js');
    await run([
      'feedback',
      '--type', 'bug',
      '--component', 'sdk',
      '--language', 'Python',
      '--title', 'storage upload hangs',
      '--detail', 'upload() never resolves for files over 5MB',
      '--area', 'storage',
    ]);

    const [payload] = (submitFeedback as Mock).mock.calls[0];
    expect(payload).toMatchObject({ component: 'sdk', language: 'python', area: 'storage' });
  });

  it('rejects an invalid severity', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      await expect(
        run(['feedback', '--type', 'bug', '--component', 'cli', '--title', 't', '--detail', 'd', '--severity', 'urgent']),
      ).rejects.toThrow('exit');
      expect(errSpy.mock.calls.flat().join('\n')).toContain('--severity must be one of');
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('files a docs-vs-behavior discrepancy as a bug with doc_ref and workaround', async () => {
    const { submitFeedback } = await import('../lib/api/feedback.js');

    await run([
      'feedback',
      '--type', 'bug',
      '--component', 'skills',
      '--title', 'skill documents a --wait flag that does not exist',
      '--detail', 'insforge-cli skill says deployments deploy supports --wait; the CLI rejects it.',
      '--doc', 'insforge-cli skill, Deployments section',
      '--expected', 'deploy blocks until the deployment finishes',
      '--workaround', 'polled deployments status in a loop instead',
    ]);

    const [payload] = (submitFeedback as Mock).mock.calls[0];
    expect(payload).toMatchObject({
      type: 'bug',
      component: 'skills',
      doc_ref: 'insforge-cli skill, Deployments section',
      workaround: 'polled deployments status in a loop instead',
    });
  });

  it('rejects retired type values', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    try {
      await expect(
        run(['feedback', '--type', 'discrepancy', '--component', 'cli', '--title', 't', '--detail', 'd']),
      ).rejects.toThrow('exit');
      expect(errSpy.mock.calls.flat().join('\n')).toContain(
        'bug, feature-request, friction, other',
      );
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('omits project context in OSS mode (fake project id)', async () => {
    const { getProjectConfig } = await import('../lib/config.js');
    (getProjectConfig as Mock).mockReturnValue({
      project_id: 'fa4e0000-1234-5678-90ab-cd1234567890',
      project_name: 'oss',
      org_id: 'o1',
      appkey: 'k',
      region: '',
      api_key: 'key',
      oss_host: 'http://localhost',
    });
    const { submitFeedback } = await import('../lib/api/feedback.js');

    await run(['feedback', '--type', 'bug', '--component', 'docs', '--title', 't', '--detail', 'd']);

    const [payload] = (submitFeedback as Mock).mock.calls[0];
    expect(payload.project_id).toBeUndefined();
    expect(payload.org_id).toBeUndefined();
  });

  it('sends only metadata to analytics, never free text', async () => {
    const { trackTopLevelCommand } = await import('../lib/analytics.js');

    await run([
      'feedback',
      '--type', 'friction',
      '--component', 'skills',
      '--title', 'secret title with jane@example.com',
      '--detail', 'sensitive detail text',
    ]);

    const calls = JSON.stringify((trackTopLevelCommand as Mock).mock.calls);
    expect(calls).toContain('feedback');
    expect(calls).not.toContain('secret title');
    expect(calls).not.toContain('sensitive detail');
    expect(calls).not.toContain('example.com');
  });

  it('truncates oversized error output but keeps head and tail', async () => {
    const { submitFeedback } = await import('../lib/api/feedback.js');
    const bigError = 'START ' + 'x'.repeat(5000) + ' END';

    await run(['feedback', '--type', 'bug', '--component', 'cli', '--title', 't', '--detail', 'd', '--error', bigError]);

    const [payload] = (submitFeedback as Mock).mock.calls[0];
    expect(payload.error.length).toBeLessThan(2200);
    expect(payload.error).toContain('START');
    expect(payload.error).toContain('END');
    expect(payload.error).toContain('chars truncated');
  });
});
