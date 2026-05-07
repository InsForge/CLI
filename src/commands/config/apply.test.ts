import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerConfigApplyCommand } from './apply.js';
import type * as ErrorsModule from '../../lib/errors.js';

// Per-test we override what /api/metadata returns by reassigning this.
let nextMetadataResponse: unknown = {};
const ossFetchMock = vi.fn(async (path: string, init?: RequestInit) => {
  if (path === '/api/metadata' && (!init || init.method === undefined || init.method === 'GET')) {
    return new Response(JSON.stringify(nextMetadataResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});

vi.mock('../../lib/api/oss.js', () => ({
  ossFetch: (path: string, init?: RequestInit) => ossFetchMock(path, init),
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
    // Force handleError to throw rather than process.exit so tests can inspect.
    handleError: vi.fn((err: unknown) => {
      throw err;
    }),
  };
});

function makeProgram(): Command {
  const program = new Command().exitOverride();
  program.option('--json').option('--yes').option('--api-url <url>');
  const cfg = program.command('config');
  registerConfigApplyCommand(cfg);
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
  tmp = mkdtempSync(join(tmpdir(), 'insforge-apply-test-'));
});

describe('config apply (capability probe)', () => {
  it('applies changes when backend exposes the field', async () => {
    nextMetadataResponse = {
      auth: { allowedRedirectUrls: ['https://old.com'] },
    };
    const tomlPath = join(tmp, 'insforge.toml');
    writeFileSync(
      tomlPath,
      '[auth]\nallowed_redirect_urls = ["https://new.com", "https://old.com"]\n',
    );

    const program = makeProgram();
    const docs = await runJson(program, [
      '--json',
      '--yes',
      'config',
      'apply',
      '--file',
      tomlPath,
    ]);

    // Single JSON doc emitted (one of the prior review items).
    expect(docs).toHaveLength(1);
    const result = docs[0] as { applied: unknown[]; skipped: unknown[] };
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    // PUT was issued.
    const putCalls = ossFetchMock.mock.calls.filter(
      (c) => c[1]?.method === 'PUT' && c[0] === '/api/auth/config',
    );
    expect(putCalls).toHaveLength(1);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('skips changes (and never PUTs) when the backend omits the field', async () => {
    // Legacy backend: auth slice exists but no allowedRedirectUrls field.
    nextMetadataResponse = { auth: { someOtherField: 'x' } };
    const tomlPath = join(tmp, 'insforge.toml');
    writeFileSync(tomlPath, '[auth]\nallowed_redirect_urls = ["https://new.com"]\n');

    const program = makeProgram();
    const docs = await runJson(program, [
      '--json',
      '--yes',
      'config',
      'apply',
      '--file',
      tomlPath,
    ]);

    const result = docs[0] as {
      applied: unknown[];
      skipped: Array<{ key: string; reason: string }>;
    };
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].key).toBe('auth.allowed_redirect_urls');
    expect(result.skipped[0].reason).toMatch(/upgrade/);
    // No PUT ever issued — protects against silent-drop on permissive servers.
    const putCalls = ossFetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT');
    expect(putCalls).toHaveLength(0);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('treats an empty array on the wire as supported (empty != absent)', async () => {
    nextMetadataResponse = { auth: { allowedRedirectUrls: [] } };
    const tomlPath = join(tmp, 'insforge.toml');
    writeFileSync(tomlPath, '[auth]\nallowed_redirect_urls = ["https://new.com"]\n');

    const program = makeProgram();
    const docs = await runJson(program, [
      '--json',
      '--yes',
      'config',
      'apply',
      '--file',
      tomlPath,
    ]);

    const result = docs[0] as { applied: unknown[]; skipped: unknown[] };
    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);

    rmSync(tmp, { recursive: true, force: true });
  });
});
