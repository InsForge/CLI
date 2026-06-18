import { describe, expect, it } from 'vitest';
import { classifyRls, classifyTruth } from './verify-probe.js';

describe('classifyRls', () => {
  it('flags rls_leak when B reads any of A\'s rows', () => {
    const r = classifyRls({ bReadRowsOfA: 3, aReadOwnRows: 5, anonReadRows: 0 });
    expect(r.type).toBe('rls_leak');
    expect(r.evidence.user_b_read_rows_of_a).toBe(3);
  });

  it('flags rls_leak when anonymous reads any rows', () => {
    expect(classifyRls({ bReadRowsOfA: 0, aReadOwnRows: 5, anonReadRows: 2 }).type).toBe('rls_leak');
  });

  it('flags rls_overrestrict when A cannot read its own rows (positive control empty)', () => {
    expect(classifyRls({ bReadRowsOfA: 0, aReadOwnRows: 0, anonReadRows: 0 }).type).toBe('rls_overrestrict');
  });

  it('passes (none) when B=0, anon=0, and A sees its own rows', () => {
    expect(classifyRls({ bReadRowsOfA: 0, aReadOwnRows: 5, anonReadRows: 0 }).type).toBe('none');
  });

  it('prioritises a real leak over the positive-control check', () => {
    // B leaks AND A sees nothing — the leak is the more severe finding to surface
    expect(classifyRls({ bReadRowsOfA: 4, aReadOwnRows: 0, anonReadRows: 0 }).type).toBe('rls_leak');
  });
});

describe('classifyTruth', () => {
  it('flags false_pass when the DB value differs from what the UI claimed', () => {
    const r = classifyTruth(1, '3');
    expect(r.type).toBe('false_pass');
    expect(r.evidence).toEqual({ ui_claimed: '3', db_actual: 1 });
  });

  it('passes when the DB value matches (number vs string normalised)', () => {
    expect(classifyTruth(3, '3').type).toBe('none');
    expect(classifyTruth('3', '3').type).toBe('none');
    expect(classifyTruth(' 3 ', '3').type).toBe('none');
  });

  it('treats null/undefined as empty and mismatching a non-empty expectation', () => {
    expect(classifyTruth(null, '3').type).toBe('false_pass');
    expect(classifyTruth(undefined, '0').type).toBe('false_pass');
  });

  it('passes when both sides are empty', () => {
    expect(classifyTruth(null, '').type).toBe('none');
  });
});
