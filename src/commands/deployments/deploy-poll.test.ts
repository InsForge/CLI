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
      .mockRejectedValueOnce(new CLIError('OSS request failed: 502', 1, undefined, 502))
      .mockResolvedValueOnce(deploymentResponse('READY', { url: 'https://app.vercel.app' }));

    const promise = pollDeployment('dep_1', null, false);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    const result = await promise;
    expect(result.isReady).toBe(true);
    expect(result.liveUrl).toBe('https://app.vercel.app');
    expect(ossMock.ossFetch).toHaveBeenCalledTimes(3);
  });

  it('still fails fast on 4xx status responses', async () => {
    ossMock.ossFetch.mockRejectedValueOnce(new CLIError('Deployment not found.', 1, 'NOT_FOUND', 404));

    const promise = pollDeployment('dep_1', null, false);
    const assertion = expect(promise).rejects.toThrow('Deployment not found.');
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
  });

  it('reports the last read failure when 5xx persists for the whole window', async () => {
    // One good read, then the gateway is down until the poll window closes.
    // Without lastError this is indistinguishable from an ordinary slow build.
    ossMock.ossFetch
      .mockResolvedValueOnce(deploymentResponse('BUILDING'))
      .mockRejectedValue(new CLIError('OSS request failed: 502', 1, undefined, 502));

    const promise = pollDeployment('dep_1', null, false);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS);

    const result = await promise;
    expect(result.isReady).toBe(false);
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
    expect(result.lastError).toContain('the deployment API');
  });

  it('leaves lastError null when the final read succeeded and the build was just slow', async () => {
    // An early transient 502 must not be reported as the timeout reason once
    // later reads succeed — otherwise a slow build looks like an outage.
    // A fresh Response per call: one instance can only be .json()'d once.
    ossMock.ossFetch
      .mockRejectedValueOnce(new CLIError('OSS request failed: 502', 1, undefined, 502))
      .mockImplementation(() => Promise.resolve(deploymentResponse('BUILDING')));

    const promise = pollDeployment('dep_1', null, false);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS);

    const result = await promise;
    expect(result.isReady).toBe(false);
    expect(result.lastError).toBeNull();
    expect(result.deployment?.status).toBe('BUILDING');
  });
});
