import { describe, expect, it } from 'vitest';
import { diffConfig } from './config-diff.js';

describe('diffConfig', () => {
  it('detects an array change in allowed_redirect_urls', () => {
    const live = { auth: { allowed_redirect_urls: ['https://a.com'] } };
    const file = { auth: { allowed_redirect_urls: ['https://a.com', 'https://b.com'] } };
    expect(diffConfig({ live, file })).toEqual({
      changes: [
        {
          section: 'auth',
          op: 'modify',
          key: 'allowed_redirect_urls',
          from: ['https://a.com'],
          to: ['https://a.com', 'https://b.com'],
        },
      ],
      summary: { add: 0, modify: 1, remove: 0, kept: 0 },
    });
  });

  it('returns no changes for converged state', () => {
    const same = { auth: { allowed_redirect_urls: ['https://a.com'] } };
    expect(diffConfig({ live: same, file: same })).toEqual({
      changes: [],
      summary: { add: 0, modify: 0, remove: 0, kept: 0 },
    });
  });

  it('treats missing field in file as no-op (no remove)', () => {
    const live = { auth: { allowed_redirect_urls: ['https://a.com'] } };
    const file = {};
    expect(diffConfig({ live, file })).toEqual({
      changes: [],
      summary: { add: 0, modify: 0, remove: 0, kept: 0 },
    });
  });

  it('treats empty-array vs non-empty as a real change', () => {
    const live = { auth: { allowed_redirect_urls: ['https://a.com'] } };
    const file = { auth: { allowed_redirect_urls: [] } };
    expect(diffConfig({ live, file }).changes).toEqual([
      {
        section: 'auth',
        op: 'modify',
        key: 'allowed_redirect_urls',
        from: ['https://a.com'],
        to: [],
      },
    ]);
  });

  it('treats reordered redirect URLs as no-op', () => {
    const live = { auth: { allowed_redirect_urls: ['https://b.com', 'https://a.com'] } };
    const file = { auth: { allowed_redirect_urls: ['https://a.com', 'https://b.com'] } };
    expect(diffConfig({ live, file }).changes).toEqual([]);
  });

  it('deduplicates redirect URLs before comparing', () => {
    const live = { auth: { allowed_redirect_urls: ['https://a.com', 'https://a.com'] } };
    const file = { auth: { allowed_redirect_urls: ['https://a.com'] } };
    expect(diffConfig({ live, file }).changes).toEqual([]);
  });

  it('emits normalized values when there is a real change', () => {
    const live = { auth: { allowed_redirect_urls: ['https://b.com', 'https://a.com'] } };
    const file = {
      auth: { allowed_redirect_urls: ['https://c.com', 'https://a.com', 'https://b.com'] },
    };
    expect(diffConfig({ live, file }).changes).toEqual([
      {
        section: 'auth',
        op: 'modify',
        key: 'allowed_redirect_urls',
        from: ['https://a.com', 'https://b.com'],
        to: ['https://a.com', 'https://b.com', 'https://c.com'],
      },
    ]);
  });
});
