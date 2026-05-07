import { describe, expect, it } from 'vitest';
import { formatPlan } from './config-format.js';

describe('formatPlan', () => {
  it('renders a single-section plan', () => {
    const out = formatPlan({
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
    expect(out).toContain('auth:');
    expect(out).toContain('~ allowed_redirect_urls:');
    expect(out).toContain('["https://a.com"]');
    expect(out).toContain('["https://a.com","https://b.com"]');
    expect(out).toContain('0 add, 1 modify, 0 remove, 0 untracked kept.');
  });

  it('renders no-change plans cleanly', () => {
    const out = formatPlan({
      changes: [],
      summary: { add: 0, modify: 0, remove: 0, kept: 0 },
    });
    expect(out).toContain('No changes. Live state matches insforge.toml.');
  });
});
