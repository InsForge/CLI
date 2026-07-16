import { describe, it, expect } from 'vitest';
import { schemaProfileHeaders } from './profile.js';

describe('schemaProfileHeaders', () => {
  it('returns no headers when no schema is given (defaults to public)', () => {
    expect(schemaProfileHeaders('read')).toEqual({});
    expect(schemaProfileHeaders('write', undefined)).toEqual({});
    expect(schemaProfileHeaders('read', '')).toEqual({});
  });

  it('uses Accept-Profile for reads', () => {
    expect(schemaProfileHeaders('read', 'analytics')).toEqual({
      'Accept-Profile': 'analytics',
    });
  });

  it('uses Content-Profile for writes', () => {
    expect(schemaProfileHeaders('write', 'analytics')).toEqual({
      'Content-Profile': 'analytics',
    });
  });
});
