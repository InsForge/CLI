import { describe, expect, it } from 'vitest';
import { sanitizeEndpoint, sanitizeMessage } from './analytics.js';

describe('sanitizeEndpoint', () => {
  it('drops the query string (params can carry tokens/PII)', () => {
    expect(sanitizeEndpoint('/api/orders?token=abc&email=x@y.com')).toBe('/api/orders');
    expect(sanitizeEndpoint('https://h/api/x?a=1')).toBe('https://h/api/x');
  });

  it('passes a bare path through and handles undefined', () => {
    expect(sanitizeEndpoint('/api/orders')).toBe('/api/orders');
    expect(sanitizeEndpoint(undefined)).toBeUndefined();
  });
});

describe('sanitizeMessage', () => {
  it('redacts email addresses (including multiple in one message)', () => {
    expect(sanitizeMessage('failed for a@b.com and c.d+tag@e.io')).toBe(
      'failed for [redacted-email] and [redacted-email]',
    );
  });

  it('redacts bearer tokens / long opaque secrets at word boundaries', () => {
    const out = sanitizeMessage('auth Bearer ey1234567890ABCDEFobcdef.tok rejected');
    expect(out).toContain('[redacted-token]');
    expect(out).not.toContain('ey1234567890');
    // short words are left alone — only 20+ char runs are treated as secrets
    expect(sanitizeMessage('short id abc123 ok')).toBe('short id abc123 ok');
  });

  it('truncates to 500 chars', () => {
    // short words separated by spaces so the token regex doesn't collapse it first
    expect(sanitizeMessage('ab '.repeat(300))?.length).toBe(500);
  });

  it('returns undefined for empty/undefined input', () => {
    expect(sanitizeMessage(undefined)).toBeUndefined();
    expect(sanitizeMessage('')).toBeUndefined();
  });
});
