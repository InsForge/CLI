import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as ErrorsModule from '../../lib/errors.js';

const ossFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api/oss.js', () => ({ ossFetch: ossFetchMock }));
vi.mock('../../lib/credentials.js', () => ({ requireAuth: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../lib/skills.js', () => ({ reportCliUsage: vi.fn() }));
vi.mock('../../lib/command-telemetry.js', () => ({ trackCommandUsage: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('export default () => new Response("ok");'),
}));
vi.mock('../../lib/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ErrorsModule>();
  return {
    ...actual,
    handleError: (err: unknown) => { throw err; },
  };
});

import { Command } from 'commander';
import { CLIError } from '../../lib/errors.js';
import { registerFunctionsDeployCommand } from './deploy.js';

function deployResponse(slug: string) {
  return {
    json: async () => ({
      success: true,
      function: { slug },
      deployment: { id: 'd1', status: 'success', url: `https://x.dev/${slug}` },
    }),
  };
}

function runDeploy(slug: string): Promise<Command> {
  const cmd = new Command();
  cmd.exitOverride();
  const functions = cmd.command('functions');
  registerFunctionsDeployCommand(functions);
  return cmd.parseAsync([
    'node', 'lim', 'functions', 'deploy', slug, '--file', './fn.ts',
  ]);
}

describe('functions deploy create-or-update', () => {
  beforeEach(() => {
    ossFetchMock.mockReset();
  });

  it('updates via PUT when the function already exists (redeploy of same slug)', async () => {
    ossFetchMock.mockResolvedValueOnce({ json: async () => ({}) }); // GET: exists
    ossFetchMock.mockResolvedValueOnce(deployResponse('hello'));

    await runDeploy('hello');

    expect(ossFetchMock).toHaveBeenCalledTimes(2);
    const [path, init] = ossFetchMock.mock.calls[1];
    expect(path).toBe('/api/functions/hello');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toMatchObject({ name: 'hello' });
  });

  it('creates via POST when the existence check returns 404', async () => {
    ossFetchMock.mockRejectedValueOnce(new CLIError('Function not found', 1, 'FUNCTION_NOT_FOUND', 404));
    ossFetchMock.mockResolvedValueOnce(deployResponse('hello'));

    await runDeploy('hello');

    expect(ossFetchMock).toHaveBeenCalledTimes(2);
    const [path, init] = ossFetchMock.mock.calls[1];
    expect(path).toBe('/api/functions');
    expect(init.method).toBe('POST');
  });

  it('surfaces a non-404 existence-check error instead of treating it as "not exists"', async () => {
    ossFetchMock.mockRejectedValueOnce(new CLIError('Internal server error', 1, 'INTERNAL_ERROR', 500));

    await expect(runDeploy('hello')).rejects.toThrow('Internal server error');
    // Must not have blindly fallen through to POST/PUT.
    expect(ossFetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to PUT when POST returns 409 (slug already exists)', async () => {
    ossFetchMock.mockRejectedValueOnce(new CLIError('Function not found', 1, 'FUNCTION_NOT_FOUND', 404)); // GET
    ossFetchMock.mockRejectedValueOnce(new CLIError('Function with this slug already exists', 1, 'FUNCTION_ALREADY_EXISTS', 409)); // POST
    ossFetchMock.mockResolvedValueOnce(deployResponse('hello')); // PUT fallback

    await runDeploy('hello');

    expect(ossFetchMock).toHaveBeenCalledTimes(3);
    const [path, init] = ossFetchMock.mock.calls[2];
    expect(path).toBe('/api/functions/hello');
    expect(init.method).toBe('PUT');
  });

  it('rethrows non-409 POST errors without retrying as PUT', async () => {
    ossFetchMock.mockRejectedValueOnce(new CLIError('Function not found', 1, 'FUNCTION_NOT_FOUND', 404)); // GET
    ossFetchMock.mockRejectedValueOnce(new CLIError('Payload too large', 1, 'PAYLOAD_TOO_LARGE', 413)); // POST

    await expect(runDeploy('hello')).rejects.toThrow('Payload too large');
    expect(ossFetchMock).toHaveBeenCalledTimes(2);
  });
});
