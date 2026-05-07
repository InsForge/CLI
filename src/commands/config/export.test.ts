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
  it('emits the auth section when the backend exposes the field', async () => {
    nextMetadataResponse = {
      auth: { allowedRedirectUrls: ['https://a.com', 'https://b.com'] },
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

    const result = docs[0] as { config: { auth?: unknown }; skipped: string[] };
    expect(result.config.auth).toEqual({
      allowed_redirect_urls: ['https://a.com', 'https://b.com'],
    });
    expect(result.skipped).toEqual([]);

    const written = readFileSync(target, 'utf8');
    expect(written).toContain('allowed_redirect_urls');

    rmSync(tmp, { recursive: true, force: true });
  });

  it('omits the auth section and reports skipped when the field is absent', async () => {
    // Older backend — auth metadata returns, but no allowedRedirectUrls key.
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
    expect(result.skipped).toEqual(['auth.allowed_redirect_urls']);
    // File is still written so future apply cycles work — just empty.
    expect(existsSync(target)).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });
});
