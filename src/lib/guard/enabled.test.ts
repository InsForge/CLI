import { describe, expect, it } from 'vitest';
import { GUARD_DEFAULT_ENABLED, guardEnabled } from './enabled.js';

describe('guardEnabled — rollout switch', () => {
  it('is off by default (shipping is a no-op until opted in)', () => {
    expect(GUARD_DEFAULT_ENABLED).toBe(false);
    expect(guardEnabled({})).toBe(false);
  });

  it('turns on for truthy INSFORGE_GUARD values', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'enabled', 'TRUE', ' On ']) {
      expect(guardEnabled({ INSFORGE_GUARD: v })).toBe(true);
    }
  });

  it('forces off for falsy INSFORGE_GUARD values', () => {
    for (const v of ['0', 'false', 'off', 'no', 'disabled']) {
      expect(guardEnabled({ INSFORGE_GUARD: v })).toBe(false);
    }
  });

  it('falls back to the default for unrecognized values', () => {
    expect(guardEnabled({ INSFORGE_GUARD: 'maybe' })).toBe(GUARD_DEFAULT_ENABLED);
  });

  it('uses the persisted project setting when the env is unset', () => {
    expect(guardEnabled({}, true)).toBe(true);
    expect(guardEnabled({}, false)).toBe(false);
    expect(guardEnabled({}, null)).toBe(GUARD_DEFAULT_ENABLED);
  });

  it('lets the env override the persisted setting (kill switch / override)', () => {
    expect(guardEnabled({ INSFORGE_GUARD: '0' }, true)).toBe(false);
    expect(guardEnabled({ INSFORGE_GUARD: '1' }, false)).toBe(true);
  });
});
