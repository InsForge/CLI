import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerConfigExportCommand } from './export.js';
import type * as ErrorsModule from '../../lib/errors.js';

let nextMetadataResponse: unknown = {};
let nextStorageConfigResponse: unknown;
let nextRealtimeConfigResponse: unknown;
let nextSchedulesConfigResponse: unknown;
let nextEmailTemplatesResponse: unknown;

const ossFetchMock = vi.fn(async (path: string) => {
  let body: unknown = nextMetadataResponse;
  if (path === '/api/storage/config') body = nextStorageConfigResponse ?? {};
  if (path === '/api/realtime/config') body = nextRealtimeConfigResponse ?? {};
  if (path === '/api/schedules/config') body = nextSchedulesConfigResponse ?? {};
  if (path === '/api/auth/email-templates') body = nextEmailTemplatesResponse ?? {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

vi.mock('../../lib/api/oss.js', () => ({
  ossFetch: (path: string) => ossFetchMock(path),
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
  nextStorageConfigResponse = undefined;
  nextRealtimeConfigResponse = undefined;
  nextSchedulesConfigResponse = undefined;
  nextEmailTemplatesResponse = undefined;
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
    // Only allowedRedirectUrls and smtpConfig are in the fixture; everything
    // else (verification flags, password policy, deployments) gets skipped.
    expect(result.skipped.sort()).toEqual([
      'auth.disable_signup',
      'auth.email_templates',
      'auth.password',
      'auth.require_email_verification',
      'auth.reset_password_method',
      'auth.verify_email_method',
      'deployments.subdomain',
      'realtime.retention_days',
      'schedules.retention_days',
      'storage.max_file_size_mb',
    ].sort());

    const written = readFileSync(target, 'utf8');
    expect(written).toContain('allowed_redirect_urls');
    expect(written).toContain('[auth.smtp]');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('exports optional endpoint-backed config sections when available', async () => {
    nextMetadataResponse = {
      auth: {
        allowedRedirectUrls: [],
        disableSignup: true,
      },
    };
    nextStorageConfigResponse = { maxFileSizeMb: 100 };
    nextRealtimeConfigResponse = { retentionDays: null };
    nextSchedulesConfigResponse = { retentionDays: 14 };
    nextEmailTemplatesResponse = {
      data: [
        {
          templateType: 'reset-password-link',
          subject: 'Reset',
          bodyHtml: '<p>Reset</p>',
        },
      ],
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
      config: {
        auth?: {
          disable_signup?: boolean;
          email_templates?: Record<string, { subject: string; body_html: string }>;
        };
        storage?: { max_file_size_mb?: number };
        realtime?: { retention_days?: number | null };
        schedules?: { retention_days?: number | null };
      };
      skipped: string[];
    };
    expect(result.config.auth?.disable_signup).toBe(true);
    expect(result.config.storage).toEqual({ max_file_size_mb: 100 });
    expect(result.config.realtime).toEqual({ retention_days: null });
    expect(result.config.schedules).toEqual({ retention_days: 14 });
    expect(result.config.auth?.email_templates?.['reset-password-link']).toEqual({
      subject: 'Reset',
      body_html: '<p>Reset</p>',
    });
    expect(result.skipped).not.toContain('storage.max_file_size_mb');
    expect(result.skipped).not.toContain('realtime.retention_days');
    expect(result.skipped).not.toContain('schedules.retention_days');
    expect(result.skipped).not.toContain('auth.email_templates');

    const written = readFileSync(target, 'utf8');
    expect(written).toContain('disable_signup = true');
    expect(written).toContain('[storage]');
    expect(written).toContain('retention_days = 0');
    expect(written).toContain('[auth.email_templates."reset-password-link"]');

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
    expect(result.skipped.sort()).toEqual([
      'auth.allowed_redirect_urls',
      'auth.disable_signup',
      'auth.email_templates',
      'auth.password',
      'auth.require_email_verification',
      'auth.reset_password_method',
      'auth.smtp',
      'auth.verify_email_method',
      'deployments.subdomain',
      'realtime.retention_days',
      'schedules.retention_days',
      'storage.max_file_size_mb',
    ].sort());
    // File is still written so future apply cycles work — just empty.
    expect(existsSync(target)).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits [deployments] when cloud backend exposes a custom slug', async () => {
    nextMetadataResponse = {
      auth: { allowedRedirectUrls: [] },
      deployments: { customSlug: 'my-app' },
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
      config: { deployments?: { subdomain?: string } };
      skipped: string[];
    };
    expect(result.config.deployments).toEqual({ subdomain: 'my-app' });
    // No smtpConfig or auth.* fields in fixture → those sections get skipped,
    // but the deployments section still emits cleanly.
    expect(result.skipped.sort()).toEqual([
      'auth.disable_signup',
      'auth.email_templates',
      'auth.password',
      'auth.require_email_verification',
      'auth.reset_password_method',
      'auth.smtp',
      'auth.verify_email_method',
      'realtime.retention_days',
      'schedules.retention_days',
      'storage.max_file_size_mb',
    ].sort());

    const written = readFileSync(target, 'utf8');
    expect(written).toContain('[deployments]');
    expect(written).toContain('subdomain = "my-app"');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('omits [deployments] when cloud backend has no slug set', async () => {
    // Slice present but customSlug: null — the project is on its default
    // URL. Emitting subdomain = "" would mean "clear on apply" (which fails
    // the 3-char min), so we leave the section out entirely.
    nextMetadataResponse = {
      auth: { allowedRedirectUrls: [] },
      deployments: { customSlug: null },
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
      config: { deployments?: unknown };
      skipped: string[];
    };
    expect(result.config.deployments).toBeUndefined();
    expect(result.skipped.sort()).toEqual([
      'auth.disable_signup',
      'auth.email_templates',
      'auth.password',
      'auth.require_email_verification',
      'auth.reset_password_method',
      'auth.smtp',
      'auth.verify_email_method',
      'realtime.retention_days',
      'schedules.retention_days',
      'storage.max_file_size_mb',
    ].sort());

    const written = readFileSync(target, 'utf8');
    expect(written).not.toContain('[deployments]');

    rmSync(tmp, { recursive: true, force: true });
  });
});
