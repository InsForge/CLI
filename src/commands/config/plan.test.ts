import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerConfigPlanCommand } from './plan.js';
import type * as ErrorsModule from '../../lib/errors.js';

let nextMetadataResponse: unknown = {};
let nextStorageConfigResponse: unknown;
const ossFetchMock = vi.fn(async (path: string) => {
  const body = path === '/api/storage/config'
    ? nextStorageConfigResponse ?? {}
    : nextMetadataResponse;
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
  registerConfigPlanCommand(cfg);
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
  tmp = mkdtempSync(join(tmpdir(), 'insforge-plan-test-'));
});

describe('config plan (capability probe)', () => {
  it('reports skipped[] empty when backend supports all sections', async () => {
    nextMetadataResponse = {
      auth: { allowedRedirectUrls: ['https://a.com'] },
    };
    const tomlPath = join(tmp, 'insforge.toml');
    writeFileSync(tomlPath, '[auth]\nallowed_redirect_urls = ["https://b.com"]\n');

    const program = makeProgram();
    const docs = await runJson(program, ['--json', 'config', 'plan', '--file', tomlPath]);
    const result = docs[0] as { changes: unknown[]; skipped: string[] };
    expect(result.changes).toHaveLength(1);
    expect(result.skipped).toEqual([]);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports skipped paths when backend omits the field', async () => {
    nextMetadataResponse = { auth: { someOtherField: 'x' } };
    const tomlPath = join(tmp, 'insforge.toml');
    writeFileSync(tomlPath, '[auth]\nallowed_redirect_urls = ["https://b.com"]\n');

    const program = makeProgram();
    const docs = await runJson(program, ['--json', 'config', 'plan', '--file', tomlPath]);
    const result = docs[0] as { changes: unknown[]; skipped: string[] };
    expect(result.changes).toHaveLength(1);
    expect(result.skipped).toEqual(['auth.allowed_redirect_urls']);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('uses optional config endpoint support for storage changes', async () => {
    nextMetadataResponse = { auth: {} };
    nextStorageConfigResponse = { maxFileSizeMb: 50 };
    const tomlPath = join(tmp, 'insforge.toml');
    writeFileSync(tomlPath, '[storage]\nmax_file_size_mb = 100\n');

    const program = makeProgram();
    const docs = await runJson(program, ['--json', 'config', 'plan', '--file', tomlPath]);
    const result = docs[0] as { changes: unknown[]; skipped: string[] };
    expect(result.changes).toHaveLength(1);
    expect(result.skipped).toEqual([]);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('marks optional config changes skipped when the endpoint does not expose the key', async () => {
    nextMetadataResponse = { auth: {} };
    const tomlPath = join(tmp, 'insforge.toml');
    writeFileSync(tomlPath, '[storage]\nmax_file_size_mb = 100\n');

    const program = makeProgram();
    const docs = await runJson(program, ['--json', 'config', 'plan', '--file', tomlPath]);
    const result = docs[0] as { changes: unknown[]; skipped: string[] };
    expect(result.changes).toHaveLength(1);
    expect(result.skipped).toEqual(['storage.max_file_size_mb']);

    rmSync(tmp, { recursive: true, force: true });
  });
});
