import { describe, expect, it } from 'vitest';
import {
  findLocalMigrationBySequence,
  formatMigrationSql,
  getNextLocalMigrationSequence,
  parseStrictLocalMigrations,
  parseMigrationFilename,
  resolveMigrationTarget,
} from './migrations.js';

describe('parseMigrationFilename', () => {
  it('parses a valid migration filename', () => {
    expect(parseMigrationFilename('12_add-post-index.sql')).toEqual({
      filename: '12_add-post-index.sql',
      sequenceNumber: 12,
      name: 'add-post-index',
    });
  });

  it('rejects invalid migration filenames', () => {
    expect(parseMigrationFilename('01_add-post-index.sql')).toBeNull();
    expect(parseMigrationFilename('1_add_post_index.sql')).toBeNull();
    expect(parseMigrationFilename('1_AddPostIndex.sql')).toBeNull();
    expect(parseMigrationFilename('1 add-post-index.sql')).toBeNull();
  });
});

describe('getNextLocalMigrationSequence', () => {
  it('returns remote latest plus one when there are no local files', () => {
    expect(getNextLocalMigrationSequence([], 5)).toBe(6);
  });

  it('extends a contiguous pending local chain', () => {
    expect(
      getNextLocalMigrationSequence(
        ['6_create-users.sql', '7_add-user-index.sql'].map((filename) =>
          parseMigrationFilename(filename)
        ).filter((migration): migration is NonNullable<typeof migration> => migration !== null),
        5
      )
    ).toBe(8);
  });

  it('fails when local pending migrations are not contiguous', () => {
    expect(() =>
      getNextLocalMigrationSequence(
        ['6_create-users.sql', '8_add-user-index.sql'].map((filename) =>
          parseMigrationFilename(filename)
        ).filter((migration): migration is NonNullable<typeof migration> => migration !== null),
        5
      )
    ).toThrow(/contiguous/i);
  });
});

describe('parseStrictLocalMigrations', () => {
  it('rejects invalid filenames', () => {
    expect(() =>
      parseStrictLocalMigrations(['6_create-users.sql', 'bad-file.sql'])
    ).toThrow(/invalid migration filename/i);
  });

  it('rejects duplicate sequence numbers', () => {
    expect(() =>
      parseStrictLocalMigrations(['6_create-users.sql', '6_create-accounts.sql'])
    ).toThrow(/duplicate local migration sequence/i);
  });
});

describe('formatMigrationSql', () => {
  it('serializes stored statements into readable SQL', () => {
    expect(formatMigrationSql(['CREATE TABLE posts (id bigint)', 'CREATE INDEX posts_id_idx ON posts (id)']))
      .toBe('CREATE TABLE posts (id bigint);\n\nCREATE INDEX posts_id_idx ON posts (id);\n');
  });
});

describe('resolveMigrationTarget', () => {
  const filenames = ['6_create-users.sql', '7_add-user-index.sql'];

  it('resolves an exact filename target', () => {
    expect(resolveMigrationTarget('7_add-user-index.sql', filenames)).toEqual({
      filename: '7_add-user-index.sql',
      sequenceNumber: 7,
      name: 'add-user-index',
    });
  });

  it('resolves a sequence-number target', () => {
    expect(resolveMigrationTarget('6', filenames)).toEqual({
      filename: '6_create-users.sql',
      sequenceNumber: 6,
      name: 'create-users',
    });
  });

  it('fails when a sequence number has no match', () => {
    expect(() => resolveMigrationTarget('9', filenames)).toThrow(/not found/i);
  });

  it('fails when a sequence number is ambiguous', () => {
    expect(() =>
      resolveMigrationTarget('6', ['6_create-users.sql', '6_create-accounts.sql'])
    ).toThrow(/multiple local migration files/i);
  });
});

describe('findLocalMigrationBySequence', () => {
  it('returns the unique match for a sequence number', () => {
    expect(findLocalMigrationBySequence(6, ['6_create-users.sql', '7_add-user-index.sql'])).toEqual({
      filename: '6_create-users.sql',
      sequenceNumber: 6,
      name: 'create-users',
    });
  });
});
