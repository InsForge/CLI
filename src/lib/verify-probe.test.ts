import { describe, expect, it } from 'vitest';
import { classifyRls, classifyTruth, isLikelyEmail, isReadOnlyQuery, isSafeIdentifier } from './verify-probe.js';

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

describe('isReadOnlyQuery', () => {
  it('allows SELECT / WITH (any case, leading whitespace, trailing semicolon)', () => {
    expect(isReadOnlyQuery('select 1')).toBe(true);
    expect(isReadOnlyQuery('SELECT * FROM t')).toBe(true);
    expect(isReadOnlyQuery('  with c as (select 1) select * from c')).toBe(true);
    expect(isReadOnlyQuery('select 1;')).toBe(true);
  });

  it('rejects writes / DDL', () => {
    expect(isReadOnlyQuery('delete from users')).toBe(false);
    expect(isReadOnlyQuery('UPDATE accounts SET balance = 0')).toBe(false);
    expect(isReadOnlyQuery('insert into t values (1)')).toBe(false);
    expect(isReadOnlyQuery('drop table t')).toBe(false);
  });

  it('rejects statement chaining', () => {
    expect(isReadOnlyQuery('select 1; delete from users')).toBe(false);
    expect(isReadOnlyQuery('select 1; update t set x = 1')).toBe(false);
  });

  it('rejects DML hidden inside a CTE (WITH … DELETE/UPDATE/INSERT/MERGE … SELECT)', () => {
    expect(isReadOnlyQuery('with x as (delete from users returning id) select id from x')).toBe(false);
    expect(isReadOnlyQuery('WITH x AS (UPDATE t SET c = 1 RETURNING id) SELECT * FROM x')).toBe(false);
    expect(isReadOnlyQuery('with x as (insert into t values (1) returning id) select id from x')).toBe(false);
    expect(isReadOnlyQuery('with x as (merge into t using s on t.id = s.id returning t.id) select id from x')).toBe(false);
  });
});

describe('isSafeIdentifier', () => {
  it('allows bare table/column names', () => {
    expect(isSafeIdentifier('user_id')).toBe(true);
    expect(isSafeIdentifier('_private')).toBe(true);
    expect(isSafeIdentifier('Orders2')).toBe(true);
  });

  it('rejects PostgREST-parameter / injection shapes', () => {
    expect(isSafeIdentifier('user_id&select=secret')).toBe(false);
    expect(isSafeIdentifier('user_id=eq.1')).toBe(false);
    expect(isSafeIdentifier('2cols')).toBe(false);
    expect(isSafeIdentifier('a b')).toBe(false);
    expect(isSafeIdentifier('')).toBe(false);
  });
});

describe('isLikelyEmail', () => {
  it('allows ordinary emails', () => {
    expect(isLikelyEmail('verify-a@example.com')).toBe(true);
    expect(isLikelyEmail('a.b+tag@sub.domain.io')).toBe(true);
  });

  it('rejects quotes / spaces / chaining used for SQL injection', () => {
    expect(isLikelyEmail("x' OR '1'='1")).toBe(false);
    expect(isLikelyEmail('a@b.com; drop table users')).toBe(false);
    expect(isLikelyEmail('not-an-email')).toBe(false);
    expect(isLikelyEmail('a @b.com')).toBe(false);
  });
});
