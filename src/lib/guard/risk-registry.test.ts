import { describe, expect, it } from 'vitest';
import { assess, type OperationContext } from './risk-registry.js';

/** Build an OperationContext for a `db query <sql>` invocation. */
const sql = (q: string): OperationContext => ({ path: 'db query', args: [q], opts: {} });
/** Build an OperationContext for an arbitrary command path. */
const cmd = (path: string, args: string[] = []): OperationContext => ({ path, args, opts: {} });

describe('assess — SQL classification (db query)', () => {
  it('flags DROP TABLE as critical', () => {
    const r = assess(sql('DROP TABLE users'));
    expect(r.severity).toBe('critical');
    expect(r.kind).toBe('sql.drop_object');
  });

  it('flags DROP SCHEMA / VIEW / MATERIALIZED VIEW as critical drop_object', () => {
    expect(assess(sql('DROP SCHEMA public CASCADE')).severity).toBe('critical');
    expect(assess(sql('DROP VIEW v')).kind).toBe('sql.drop_object');
    expect(assess(sql('DROP MATERIALIZED VIEW mv')).kind).toBe('sql.drop_object');
  });

  it('flags TRUNCATE as critical', () => {
    const r = assess(sql('TRUNCATE payments'));
    expect(r.severity).toBe('critical');
    expect(r.kind).toBe('sql.truncate');
  });

  it('flags DELETE without WHERE as critical (delete_all)', () => {
    const r = assess(sql('DELETE FROM accounts'));
    expect(r.severity).toBe('critical');
    expect(r.kind).toBe('sql.delete_all');
  });

  it('treats DELETE *with* WHERE as a lower-severity mutation', () => {
    const r = assess(sql('DELETE FROM accounts WHERE id = 1'));
    expect(r.severity).toBe('high');
    expect(r.kind).toBe('sql.mutation');
  });

  it('flags UPDATE without WHERE as critical (update_all)', () => {
    const r = assess(sql('UPDATE accounts SET active = false'));
    expect(r.severity).toBe('critical');
    expect(r.kind).toBe('sql.update_all');
  });

  it('treats UPDATE *with* WHERE as a lower-severity mutation', () => {
    expect(assess(sql('UPDATE accounts SET active = false WHERE id = 1')).kind).toBe('sql.mutation');
  });

  it('flags ALTER TABLE ... DROP as high (alter_drop)', () => {
    const r = assess(sql('ALTER TABLE users DROP COLUMN email'));
    expect(r.severity).toBe('high');
    expect(r.kind).toBe('sql.alter_drop');
  });

  it('flags RLS changes as high', () => {
    expect(assess(sql('DROP POLICY p ON users')).kind).toBe('sql.rls_change');
    expect(assess(sql('ALTER POLICY p ON users USING (true)')).kind).toBe('sql.rls_change');
    expect(assess(sql('ALTER TABLE users DISABLE ROW LEVEL SECURITY')).kind).toBe('sql.rls_change');
  });

  it('does NOT interrupt read/insert/create statements', () => {
    expect(assess(sql('SELECT * FROM users')).severity).toBe('safe');
    expect(assess(sql('INSERT INTO users (id) VALUES (1)')).severity).toBe('safe');
    expect(assess(sql('CREATE TABLE t (id int)')).severity).toBe('safe');
  });

  it('is case-insensitive', () => {
    expect(assess(sql('drop table users')).severity).toBe('critical');
    expect(assess(sql('  TrUnCaTe   payments ')).severity).toBe('critical');
  });
});

describe('assess — command-path classification', () => {
  it('flags registered destructive commands with the right severity', () => {
    expect(assess(cmd('storage delete-bucket', ['uploads'])).severity).toBe('critical');
    expect(assess(cmd('compute delete', ['svc'])).severity).toBe('critical');
    expect(assess(cmd('functions delete', ['fn'])).severity).toBe('high');
    expect(assess(cmd('secrets delete', ['KEY'])).severity).toBe('high');
  });

  it('catches unregistered destructive verbs (defense in depth)', () => {
    const r = assess(cmd('widgets destroy', ['x']));
    expect(r.severity).toBe('high');
    expect(r.kind).toBe('generic.destroy');
  });

  it('does NOT interrupt safe commands', () => {
    expect(assess(cmd('projects list')).severity).toBe('safe');
    expect(assess(cmd('db tables')).severity).toBe('safe');
    expect(assess(cmd('whoami')).severity).toBe('safe');
  });
});

describe('assess — trust boundary', () => {
  it('depends only on the operation, never on caller-supplied opts', () => {
    const base = assess({ path: 'db query', args: ['DROP TABLE users'], opts: {} });
    // An agent cannot smuggle in opts that downgrade the verdict.
    const withOpts = assess({
      path: 'db query',
      args: ['DROP TABLE users'],
      opts: { safe: true, force: true, severity: 'safe', reason: 'totally fine' },
    });
    expect(withOpts).toEqual(base);
    expect(withOpts.severity).toBe('critical');
  });
});
