// CLI/src/lib/config-format.test.ts
import { describe, expect, it } from 'vitest';
import { formatPlan } from './config-format.js';

describe('formatPlan', () => {
  it('renders a multi-section plan with kept warnings', () => {
    const out = formatPlan({
      changes: [
        { section: 'auth', op: 'modify', key: 'jwt_expiry', from: 3600, to: 7200 },
        { section: 'storage.buckets', op: 'add', key: 'avatars', value: { public: true } },
        { section: 'storage.buckets', op: 'modify', key: 'user-files', field: 'public', from: false, to: true },
        { section: 'storage.buckets', op: 'remove', key: 'old-bucket', kept: true },
      ],
      summary: { add: 1, modify: 2, remove: 0, kept: 1 },
    });
    expect(out).toContain('auth:');
    expect(out).toContain('~ jwt_expiry: 3600 → 7200');
    expect(out).toContain('storage.buckets:');
    expect(out).toContain('+ avatars');
    expect(out).toContain('~ user-files: public false → true');
    expect(out).toContain('- old-bucket (in DB, not in file — KEPT; use --prune to delete)');
    expect(out).toContain('1 add, 2 modify, 0 remove, 1 untracked kept');
  });

  it('renders no-change plans cleanly', () => {
    const out = formatPlan({ changes: [], summary: { add: 0, modify: 0, remove: 0, kept: 0 } });
    expect(out).toContain('No changes. Live state matches insforge.toml.');
  });
});
