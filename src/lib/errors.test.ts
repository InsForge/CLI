import { describe, expect, it } from 'vitest';
import { formatFetchError } from './errors.js';

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
