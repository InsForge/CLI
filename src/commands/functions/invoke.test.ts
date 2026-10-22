import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as ErrorsModule from '../../lib/errors.js';

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => ({ api_key: 'key', oss_host: 'https://oss.example.com' })),
}));

vi.mock('../../lib/command-telemetry.js', () => ({
  trackCommandUsage: vi.fn(),
}));

vi.mock('../../lib/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorsModule>();
  return {
    ...actual,
    handleError: (err: unknown) => {
      throw err;
    },
  };
});

import { Command } from 'commander';
import { registerFunctionsInvokeCommand } from './invoke.js';

function runInvoke(args: string[]): Promise<Command> {
  const cmd = new Command();
  cmd.exitOverride();
  const functions = cmd.command('functions');
  registerFunctionsInvokeCommand(functions);
  return cmd.parseAsync(['node', 'cli', 'functions', 'invoke', ...args]);
}

describe('functions invoke --data validation', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      headers: { get: () => 'application/json' },
      status: 200,
      json: async () => ({ ok: true }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects malformed JSON with a clear error and never calls fetch', async () => {
    await expect(runInvoke(['ingest', '--data', '{a:1}'])).rejects.toThrow('Invalid JSON in --data');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends valid --data JSON verbatim as the body', async () => {
    await runInvoke(['ingest', '--data', '{"a":1}']);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe('{"a":1}');
  });

  it('rejects when both --data and --data-file are given', async () => {
    await expect(
      runInvoke(['ingest', '--data', '{"a":1}', '--data-file', './body.json'])
    ).rejects.toThrow('mutually exclusive');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
