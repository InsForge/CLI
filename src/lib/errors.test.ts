import { describe, expect, it } from 'vitest';
import {
  AuthError,
  CLIError,
  NETWORK_ERROR_CODE,
  formatFetchError,
  isTransientApiError,
} from './errors.js';

function fetchError(causeCode?: string, causeMessage?: string): Error {
  const err = new Error('fetch failed');
  if (causeCode || causeMessage) {
    const cause = new Error(causeMessage ?? '');
    if (causeCode) (cause as { code?: string }).code = causeCode;
    (err as { cause?: unknown }).cause = cause;
  }
  return err;
}

describe('formatFetchError', () => {
  const url = 'https://api.example.com/v1/things';

  it('handles ENOTFOUND as DNS failure with host', () => {
    const msg = formatFetchError(fetchError('ENOTFOUND'), url);
    expect(msg).toContain('api.example.com');
    expect(msg).toContain('DNS');
  });

  it('handles EAI_AGAIN as DNS failure', () => {
    const msg = formatFetchError(fetchError('EAI_AGAIN'), url);
    expect(msg).toContain('DNS');
  });

  it('handles ECONNREFUSED', () => {
    const msg = formatFetchError(fetchError('ECONNREFUSED'), url);
    expect(msg).toContain('refused');
    expect(msg).toContain('api.example.com');
  });

  it('handles ETIMEDOUT', () => {
    const msg = formatFetchError(fetchError('ETIMEDOUT'), url);
    expect(msg).toContain('timed out');
  });

  it('handles UND_ERR_CONNECT_TIMEOUT as timeout', () => {
    const msg = formatFetchError(fetchError('UND_ERR_CONNECT_TIMEOUT'), url);
    expect(msg).toContain('timed out');
  });

  it('handles ECONNRESET', () => {
    const msg = formatFetchError(fetchError('ECONNRESET'), url);
    expect(msg).toContain('reset');
  });

  it('handles TLS cert errors', () => {
    const msg = formatFetchError(fetchError('CERT_HAS_EXPIRED'), url);
    expect(msg).toContain('TLS');
    expect(msg).toContain('CERT_HAS_EXPIRED');
  });

  it('falls back to the cause code when unknown', () => {
    const msg = formatFetchError(fetchError('WEIRD_CODE', 'boom'), url);
    expect(msg).toContain('WEIRD_CODE');
    expect(msg).toContain('boom');
  });

  it('falls back to cause message when no code', () => {
    const msg = formatFetchError(fetchError(undefined, 'socket hang up'), url);
    expect(msg).toContain('socket hang up');
  });

  it('passes through non-"fetch failed" errors unchanged', () => {
    const err = new Error('something else');
    expect(formatFetchError(err, url)).toBe('something else');
  });

  it('handles non-Error values', () => {
    expect(formatFetchError('bad thing', url)).toContain('bad thing');
  });

  it('handles a URL that is just a host string', () => {
    const msg = formatFetchError(fetchError('ENOTFOUND'), 'broken-host');
    expect(msg).toContain('broken-host');
  });
});

describe('isTransientApiError', () => {
  it('treats gateway 5xx as transient — the poll must survive one 502', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isTransientApiError(new CLIError('Request failed', 1, undefined, status))).toBe(true);
    }
  });

  it('treats a tagged network failure as transient', () => {
    expect(
      isTransientApiError(new CLIError('Connection reset', 1, NETWORK_ERROR_CODE)),
    ).toBe(true);
  });

  it('treats rate limiting and request timeout as transient', () => {
    expect(isTransientApiError(new CLIError('Too many requests', 1, undefined, 429))).toBe(true);
    expect(isTransientApiError(new CLIError('Request timeout', 1, undefined, 408))).toBe(true);
  });

  it('treats real API rejections as terminal', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isTransientApiError(new CLIError('Nope', 1, undefined, status))).toBe(false);
    }
    expect(isTransientApiError(new AuthError())).toBe(false);
  });

  it('treats a locally raised CLIError (no status) as terminal', () => {
    // e.g. "Branch creation failed (state: deleted)" — retrying only burns the
    // poll budget on an answer that will not change.
    expect(isTransientApiError(new CLIError('Branch creation failed (state: deleted)'))).toBe(false);
  });

  it('treats a raw non-CLIError throw as transient', () => {
    // ossFetch does not wrap fetch rejections, so these arrive as plain errors.
    expect(isTransientApiError(new TypeError('fetch failed'))).toBe(true);
  });
});
