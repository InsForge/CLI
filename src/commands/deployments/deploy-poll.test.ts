import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIError } from '../../lib/errors.js';

const ossMock = vi.hoisted(() => ({
  ossFetch: vi.fn(),
}));
vi.mock('../../lib/api/oss.js', () => ossMock);

import { pollDeployment, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from './deploy.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deploymentResponse(status: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ id: 'dep_1', status, url: null, metadata: null, ...extra });
}

function httpError(message: string, statusCode: number, code?: string): CLIError {
  return new CLIError(message, 1, code, statusCode);
}

beforeEach(() => {
  vi.useFakeTimers();
  ossMock.ossFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pollDeployment', () => {
  it('keeps polling through a transient gateway 502 and resolves once READY', async () => {
    ossMock.ossFetch
      .mockResolvedValueOnce(deploymentResponse('BUILDING'))
      .mockRejectedValueOnce(httpError('OSS request failed: 502', 502))
      .mockResolvedValueOnce(deploymentResponse('READY', { url: 'https://app.vercel.app' }));

    const promise = pollDeployment('dep_1', null, false);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    const result = await promise;
    expect(result.isReady).toBe(true);
    expect(result.liveUrl).toBe('https://app.vercel.app');
    expect(result.lastError).toBeNull();
    expect(ossMock.ossFetch).toHaveBeenCalledTimes(3);
  });

  it('tolerates a 429 while polling — rate limits are transient too', async () => {
    ossMock.ossFetch
      .mockRejectedValueOnce(httpError('Too many requests', 429, 'RATE_LIMITED'))
      .mockResolvedValueOnce(deploymentResponse('READY', { url: 'https://app.vercel.app' }));

    const promise = pollDeployment('dep_1', null, false);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

    const result = await promise;
    expect(result.isReady).toBe(true);
    expect(result.lastError).toBeNull();
  });

  it('tolerates a transient failure on the sync request when syncBeforeRead is set', async () => {
    ossMock.ossFetch
      // round 1: the sync POST itself 503s, so the status read never happens
      .mockRejectedValueOnce(httpError('OSS request failed: 503', 503))
      // round 2: sync succeeds, then the status read reports READY
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(deploymentResponse('READY', { url: 'https://app.vercel.app' }));

    const promise = pollDeployment('dep_1', null, true);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

    const result = await promise;
    expect(result.isReady).toBe(true);
    expect(result.liveUrl).toBe('https://app.vercel.app');
    expect(ossMock.ossFetch).toHaveBeenCalledTimes(3);
  });

  it('still fails fast on 4xx status responses', async () => {
    ossMock.ossFetch.mockRejectedValueOnce(httpError('Deployment not found.', 404, 'NOT_FOUND'));

    const promise = pollDeployment('dep_1', null, false);
    const assertion = expect(promise).rejects.toThrow('Deployment not found.');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await assertion;
    expect(ossMock.ossFetch).toHaveBeenCalledTimes(1);
  });

  it('still fails fast on 501 — an unimplemented route will not start working mid-poll', async () => {
    ossMock.ossFetch.mockRejectedValueOnce(httpError('Not implemented', 501));

    const promise = pollDeployment('dep_1', null, false);
    const assertion = expect(promise).rejects.toThrow('Not implemented');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await assertion;
    expect(ossMock.ossFetch).toHaveBeenCalledTimes(1);
  });

  it('still fails fast on CLIErrors with no statusCode (auth, project-not-linked)', async () => {
    ossMock.ossFetch.mockRejectedValueOnce(new CLIError('Not authenticated.', 2, 'AUTH_ERROR'));

    const promise = pollDeployment('dep_1', null, false);
    const assertion = expect(promise).rejects.toThrow('Not authenticated.');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await assertion;
    expect(ossMock.ossFetch).toHaveBeenCalledTimes(1);
  });

  it('still fails when the deployment itself reports ERROR', async () => {
    ossMock.ossFetch.mockResolvedValueOnce(deploymentResponse('ERROR'));

    const promise = pollDeployment('dep_1', null, false);
    const assertion = expect(promise).rejects.toThrow('Deployment failed with status: ERROR');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await assertion;
    expect(ossMock.ossFetch).toHaveBeenCalledTimes(1);
  });

  it('reports the last read failure when 5xx persists for the whole window', async () => {
    // One good read, then the gateway is down until the poll window closes.
    // The deployment never reaches READY, so the caller must be able to tell
    // this apart from an ordinary slow build.
    ossMock.ossFetch
      .mockResolvedValueOnce(deploymentResponse('BUILDING'))
      .mockRejectedValue(httpError('OSS request failed: 502', 502));

    const promise = pollDeployment('dep_1', null, false);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS);

    const result = await promise;
    expect(result.isReady).toBe(false);
    expect(result.liveUrl).toBeNull();
    expect(result.lastError).toBe('OSS request failed: 502');
    // Last known status is still surfaced for context.
    expect(result.deployment?.status).toBe('BUILDING');
  });

  it('reports a network-level failure that persists for the whole window', async () => {
    ossMock.ossFetch.mockRejectedValue(new TypeError('fetch failed'));

    const promise = pollDeployment('dep_1', null, false);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS);

    const result = await promise;
    expect(result.isReady).toBe(false);
    expect(result.lastError).toContain('the deployment status endpoint');
  });

  it('leaves lastError null when the final read succeeded and the build was just slow', async () => {
    // A transient 502 early on must not be reported as the timeout reason once
    // later reads succeed — otherwise a slow build looks like an outage.
    // A fresh Response per call — a single instance can only be .json()'d once.
    ossMock.ossFetch
      .mockRejectedValueOnce(httpError('OSS request failed: 502', 502))
      .mockImplementation(() => Promise.resolve(deploymentResponse('BUILDING')));

    const promise = pollDeployment('dep_1', null, false);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS);

    const result = await promise;
    expect(result.isReady).toBe(false);
    expect(result.lastError).toBeNull();
    expect(result.deployment?.status).toBe('BUILDING');
  });
});
