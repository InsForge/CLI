import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type * as ErrorsModule from '../../lib/errors.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

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
    vi.mocked(readFileSync).mockReset();
    fetchMock.mockResolvedValue({
      headers: { get: () => 'application/json' },
      status: 200,
      json: async () => ({ ok: true }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects malformed --data JSON with the PowerShell/--data-file guidance and never calls fetch', async () => {
    await expect(runInvoke(['ingest', '--data', '{a:1}'])).rejects.toThrow(
      /Invalid JSON in --data\..*PowerShell.*--data-file/s
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends valid --data JSON verbatim as the body', async () => {
    await runInvoke(['ingest', '--data', '{"a":1}']);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe('{"a":1}');
  });

  it('rejects an empty --data value instead of silently sending no body', async () => {
    await expect(runInvoke(['ingest', '--data', ''])).rejects.toThrow('Invalid JSON in --data');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when both --data and --data-file are given', async () => {
    await expect(
      runInvoke(['ingest', '--data', '{"a":1}', '--data-file', './body.json'])
    ).rejects.toThrow('mutually exclusive');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when --data is empty and --data-file is also given', async () => {
    await expect(
      runInvoke(['ingest', '--data', '', '--data-file', './body.json'])
    ).rejects.toThrow('mutually exclusive');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads valid --data-file JSON and sends it verbatim as the body', async () => {
    vi.mocked(readFileSync).mockReturnValue('{"a":1}');

    await runInvoke(['ingest', '--data-file', './body.json']);

    expect(readFileSync).toHaveBeenCalledWith(expect.stringContaining('body.json'), 'utf-8');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe('{"a":1}');
  });

  it('strips a leading UTF-8 BOM from --data-file content before parsing', async () => {
    vi.mocked(readFileSync).mockReturnValue('﻿{"a":1}');

    await runInvoke(['ingest', '--data-file', './body.json']);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe('{"a":1}');
  });

  it('rejects malformed --data-file JSON with a file-specific error and never calls fetch', async () => {
    vi.mocked(readFileSync).mockReturnValue('{a:1}');

    await expect(runInvoke(['ingest', '--data-file', './body.json'])).rejects.toThrow(
      'Invalid JSON in --data-file at ./body.json'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
