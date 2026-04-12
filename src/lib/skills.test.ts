import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeExecError, reportCliUsage } from './skills.js';

function execError(opts: {
  killed?: boolean;
  signal?: string;
  code?: number | string;
  stderr?: string;
  message?: string;
}): Error {
  const err = new Error(opts.message ?? 'Command failed');
  Object.assign(err, opts);
  return err;
}

describe('describeExecError', () => {
  it('classifies a SIGTERM-killed process as a timeout', () => {
    const msg = describeExecError(execError({ killed: true, signal: 'SIGTERM' }));
    expect(msg).toContain('timed out');
    expect(msg).toContain('60s');
  });

  it('classifies a SIGKILL-killed process as a timeout', () => {
    const msg = describeExecError(execError({ killed: true, signal: 'SIGKILL' }));
    expect(msg).toContain('timed out');
  });

  it('reports missing npx (ENOENT)', () => {
    const msg = describeExecError(execError({ code: 'ENOENT' }));
    expect(msg).toContain('npx');
    expect(msg).toContain('PATH');
  });

  it('detects DNS failure in stderr', () => {
    const stderr = 'npm ERR! network request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org';
    const msg = describeExecError(execError({ code: 1, stderr }));
    expect(msg).toContain('DNS');
  });

  it('detects connection refused', () => {
    const msg = describeExecError(execError({ code: 1, stderr: 'ECONNREFUSED 127.0.0.1:443' }));
    expect(msg).toContain('refused');
  });

  it('detects network timeout in stderr', () => {
    const msg = describeExecError(execError({ code: 1, stderr: 'npm ERR! network timeout at: https://registry.npmjs.org' }));
    expect(msg).toContain('timed out');
  });

  it('detects TLS interception', () => {
    const msg = describeExecError(execError({ code: 1, stderr: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }));
    expect(msg).toContain('TLS');
  });

  it('detects 404 package not found', () => {
    const msg = describeExecError(execError({ code: 1, stderr: 'npm ERR! 404 Not Found - GET https://registry.npmjs.org/skills' }));
    expect(msg).toContain('404');
  });

  it('detects permission denied', () => {
    const msg = describeExecError(execError({ code: 1, stderr: 'EACCES: permission denied, mkdir /usr/local/lib/node_modules' }));
    expect(msg).toContain('permission');
  });

  it('detects disk full', () => {
    const msg = describeExecError(execError({ code: 1, stderr: 'ENOSPC: no space left on device' }));
    expect(msg).toContain('disk');
  });

  it('detects npm auth failure', () => {
    const msg = describeExecError(execError({ code: 1, stderr: 'npm ERR! code E401\nnpm ERR! authentication required' }));
    expect(msg).toContain('authentication');
  });

  it('falls back to exit code for unrecognized failures', () => {
    const msg = describeExecError(execError({ code: 42, stderr: 'some weird unclassified error' }));
    expect(msg).toContain('42');
  });

  it('falls back to error message when no other info', () => {
    const msg = describeExecError(execError({ message: 'mystery' }));
    expect(msg).toContain('mystery');
  });

  it('prefers timeout classification over a populated stderr', () => {
    const msg = describeExecError(execError({
      killed: true,
      signal: 'SIGTERM',
      code: 1,
      stderr: 'ENOTFOUND registry.npmjs.org',
    }));
    expect(msg).toContain('timed out');
    expect(msg).not.toContain('DNS');
  });

  it('handles Buffer stderr', () => {
    const err = execError({ code: 1 });
    (err as unknown as { stderr: Buffer }).stderr = Buffer.from('EACCES: permission denied');
    expect(describeExecError(err)).toContain('permission');
  });
});

describe('reportCliUsage', () => {
  const explicitConfig = { oss_host: 'https://proj.region.insforge.app', api_key: 'test-key' };
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses the explicit config when provided (does not touch filesystem)', async () => {
    await reportCliUsage('cli.link', true, 1, explicitConfig);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://proj.region.insforge.app/api/usage/mcp');

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.tool_name).toBe('cli.link');
    expect(body.success).toBe(true);
    expect(typeof body.timestamp).toBe('string');
  });

  it('stops retrying once a non-5xx response arrives', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await reportCliUsage('cli.link', true, 5, explicitConfig);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends success=false for failures', async () => {
    await reportCliUsage('cli.link', false, 1, explicitConfig);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.success).toBe(false);
  });
});
