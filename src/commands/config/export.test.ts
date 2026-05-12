import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerConfigExportCommand } from './export.js';
import type * as ErrorsModule from '../../lib/errors.js';

let nextMetadataResponse: unknown = {};
const ossFetchMock = vi.fn(async () => {
  return new Response(JSON.stringify(nextMetadataResponse), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

vi.mock('../../lib/api/oss.js', () => ({
  ossFetch: () => ossFetchMock(),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));

vi.mock('../../lib/skills.js', () => ({
  reportCliUsage: vi.fn(async () => {}),
}));

vi.mock('../../lib/errors.js', async (orig) => {
  const actual = await orig<typeof ErrorsModule>();
  return {
    ...actual,
    handleError: vi.fn((err: unknown) => {
      throw err;
    }),
  };
});

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>');
  const cfg = program.command('config');
  registerConfigExportCommand(cfg);
  return program;
}

async function runJson(program: Command, argv: string[]): Promise<unknown[]> {
  const out: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
    out.push(args.map(String).join(' '));
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    logSpy.mockRestore();
  }
  return out.flatMap((s) => {
    try {
      return [JSON.parse(s)];
    } catch {
      return [];
    }
  });
}

let tmp: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmp = mkdtempSync(join(tmpdir(), 'insforge-export-test-'));
});

describe('config export (capability probe)', () => {
  it('emits both auth sections when the backend exposes both fields', async () => {
    nextMetadataResponse = {
      auth: {
        allowedRedirectUrls: ['https://a.com', 'https://b.com'],
        smtpConfig: {
          enabled: false,
          host: '',
          port: 587,
          username: '',
          hasPassword: false,
          senderEmail: '',
          senderName: '',
          minIntervalSeconds: 60,
        },
      },
    };
    const target = join(tmp, 'insforge.toml');
    const program = makeProgram();
    const docs = await runJson(program, [
      '--json',
      'config',
      'export',
      '--out',
      target,
      '--force',
    ]);

    const result = docs[0] as {
      config: { auth?: { smtp?: unknown; allowed_redirect_urls?: unknown } };
      skipped: string[];
    };
    expect(result.config.auth?.allowed_redirect_urls).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
    expect(result.config.auth?.smtp).toBeDefined();
    expect(result.skipped).toEqual([]);

    const written = readFileSync(target, 'utf8');
    expect(written).toContain('allowed_redirect_urls');
    expect(written).toContain('[auth.smtp]');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits env(SMTP_PASSWORD) placeholder when hasPassword is true', async () => {
    nextMetadataResponse = {
      auth: {
        allowedRedirectUrls: [],
        smtpConfig: {
          enabled: true,
          host: 'smtp.gmail.com',
          port: 587,
          username: 'user@gmail.com',
          hasPassword: true,
          senderEmail: 'noreply@app.com',
          senderName: 'App',
          minIntervalSeconds: 60,
        },
      },
    };
    const target = join(tmp, 'insforge.toml');
    const program = makeProgram();
    const docs = await runJson(program, [
      '--json',
      'config',
      'export',
      '--out',
      target,
      '--force',
    ]);

    const result = docs[0] as {
      config: { auth?: { smtp?: { password?: string } } };
      skipped: string[];
    };
    expect(result.config.auth?.smtp?.password).toBe('env(SMTP_PASSWORD)');

    const written = readFileSync(target, 'utf8');
    expect(written).toContain('password = "env(SMTP_PASSWORD)"');
    expect(written).toContain('insforge secrets add SMTP_PASSWORD');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('omits the password field when hasPassword is false', async () => {
    nextMetadataResponse = {
      auth: {
        allowedRedirectUrls: [],
        smtpConfig: {
          enabled: false,
          host: '',
          port: 587,
          username: '',
          hasPassword: false,
          senderEmail: '',
          senderName: '',
          minIntervalSeconds: 60,
        },
      },
    };
    const target = join(tmp, 'insforge.toml');
    const program = makeProgram();
    const docs = await runJson(program, [
      '--json',
      'config',
      'export',
      '--out',
      target,
      '--force',
    ]);

    const result = docs[0] as {
      config: { auth?: { smtp?: { password?: string } } };
    };
    expect(result.config.auth?.smtp?.password).toBeUndefined();

    const written = readFileSync(target, 'utf8');
    expect(written).not.toContain('password');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('omits sections and reports skipped when fields are absent (older backend)', async () => {
    nextMetadataResponse = { auth: { someOtherField: 'x' } };
    const target = join(tmp, 'insforge.toml');
    const program = makeProgram();
    const docs = await runJson(program, [
      '--json',
      'config',
      'export',
      '--out',
      target,
      '--force',
    ]);

    const result = docs[0] as { config: { auth?: unknown }; skipped: string[] };
    expect(result.config.auth).toBeUndefined();
    expect(result.skipped.sort()).toEqual(['auth.allowed_redirect_urls', 'auth.smtp']);
    expect(existsSync(target)).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });
});
