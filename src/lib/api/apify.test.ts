import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIError } from '../errors.js';
import { fetchApifyConnection, pollApifyConnection } from './apify.js';

const API = 'https://platform.test';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Queue a sequence of fetch outcomes. Each entry is either a Response or a
// function that throws (network error). The last entry repeats once exhausted.
function mockFetchSequence(outcomes: Array<Response | (() => never)>): void {
  let i = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (): Promise<Response> => {
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i += 1;
    if (typeof outcome === 'function') return outcome();
    return outcome;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchApifyConnection', () => {
  it('maps 404 to not-connected', async () => {
    mockFetchSequence([jsonResponse({}, 404)]);
    await expect(fetchApifyConnection('p1', 'jwt', API)).resolves.toEqual({ kind: 'not-connected' });
  });

  it('maps 403 to forbidden with the backend message', async () => {
    mockFetchSequence([jsonResponse({ error: 'no access' }, 403)]);
    await expect(fetchApifyConnection('p1', 'jwt', API)).resolves.toEqual({
      kind: 'forbidden',
      message: 'no access',
    });
  });

  it('maps 401 to unauthorized (non-transient)', async () => {
    mockFetchSequence([jsonResponse({ error: 'token expired' }, 401)]);
    await expect(fetchApifyConnection('p1', 'jwt', API)).resolves.toEqual({
      kind: 'unauthorized',
      message: 'token expired',
    });
  });

  it('maps 5xx to error carrying the status', async () => {
    mockFetchSequence([jsonResponse({ error: 'boom' }, 500)]);
    await expect(fetchApifyConnection('p1', 'jwt', API)).resolves.toEqual({
      kind: 'error',
      message: 'boom',
      status: 500,
    });
  });

  it('returns connected when 200 carries a status', async () => {
    mockFetchSequence([jsonResponse({ status: 'active', apifyUsername: 'carmen' })]);
    await expect(fetchApifyConnection('p1', 'jwt', API)).resolves.toEqual({
      kind: 'connected',
      connection: { status: 'active', apifyUsername: 'carmen' },
    });
  });

  it('remaps a revoked connection to not-connected', async () => {
    mockFetchSequence([jsonResponse({ status: 'revoked' })]);
    await expect(fetchApifyConnection('p1', 'jwt', API)).resolves.toEqual({ kind: 'not-connected' });
  });

  it('treats a 200 with no status as not-connected (keeps polling)', async () => {
    mockFetchSequence([jsonResponse({})]);
    await expect(fetchApifyConnection('p1', 'jwt', API)).resolves.toEqual({ kind: 'not-connected' });
  });

  it('maps a network failure to error', async () => {
    mockFetchSequence([
      () => {
        throw new Error('ECONNREFUSED');
      },
    ]);
    const res = await fetchApifyConnection('p1', 'jwt', API);
    expect(res.kind).toBe('error');
  });
});

describe('pollApifyConnection', () => {
  const fastOpts = { timeoutMs: 5_000, intervalMs: 2, maxTransientRetries: 3 };

  it('returns the connection once the endpoint reports connected', async () => {
    mockFetchSequence([
      jsonResponse({}, 404),
      jsonResponse({ status: 'active', apifyUsername: 'carmen' }),
    ]);
    await expect(pollApifyConnection('p1', 'jwt', fastOpts, API)).resolves.toEqual({
      status: 'active',
      apifyUsername: 'carmen',
    });
  });

  it('short-circuits on 403 (exit code 5)', async () => {
    mockFetchSequence([jsonResponse({ error: 'no access' }, 403)]);
    await expect(pollApifyConnection('p1', 'jwt', fastOpts, API)).rejects.toMatchObject({
      exitCode: 5,
    });
  });

  it('short-circuits on 401 instead of burning retries (exit code 2)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}, 401));
    await expect(pollApifyConnection('p1', 'jwt', fastOpts, API)).rejects.toMatchObject({
      exitCode: 2,
    });
    // Exactly one call — not retried against the transient budget.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxTransientRetries consecutive errors', async () => {
    mockFetchSequence([jsonResponse({ error: 'boom' }, 500)]);
    await expect(
      pollApifyConnection('p1', 'jwt', { ...fastOpts, maxTransientRetries: 3 }, API),
    ).rejects.toThrow(/after 3 retries/);
  });

  it('resets the transient counter when a poll succeeds as not-connected', async () => {
    // With maxTransientRetries=2 and no reset, two errors would throw. The
    // not-connected in between resets the counter, so the final connected wins.
    mockFetchSequence([
      jsonResponse({ error: 'boom' }, 500),
      jsonResponse({}, 404),
      jsonResponse({ error: 'boom' }, 500),
      jsonResponse({ status: 'active' }),
    ]);
    await expect(
      pollApifyConnection('p1', 'jwt', { ...fastOpts, maxTransientRetries: 2 }, API),
    ).resolves.toEqual({ status: 'active' });
  });

  it('throws on deadline', async () => {
    mockFetchSequence([jsonResponse({}, 404)]);
    await expect(
      pollApifyConnection('p1', 'jwt', { timeoutMs: 5, intervalMs: 20, maxTransientRetries: 3 }, API),
    ).rejects.toThrow(/Timed out/);
  });

  it('throws when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      pollApifyConnection('p1', 'jwt', { ...fastOpts, signal: ac.signal }, API),
    ).rejects.toThrow(/cancelled/i);
  });
});
