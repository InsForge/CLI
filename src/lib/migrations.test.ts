import { describe, expect, it } from 'vitest';
import {
  assertValidMigrationVersion,
  compareMigrationVersions,
  findLocalMigrationByVersion,
  findOlderThanHeadLocalMigrations,
  formatMigrationSql,
  getNextLocalMigrationVersion,
  getRemoteMigrationVersionStatus,
  incrementMigrationVersion,
  parseStrictLocalMigrations,
  parseMigrationFilename,
  resolveMigrationTarget,
} from './migrations.js';

describe('parseMigrationFilename', () => {
  it('parses a valid migration filename', () => {
    expect(parseMigrationFilename('20260418091500_add-post-index.sql')).toEqual({
      filename: '20260418091500_add-post-index.sql',
      version: '20260418091500',
      name: 'add-post-index',
    });
  });

  it('rejects invalid migration filenames', () => {
    expect(parseMigrationFilename('20260418_add-post-index.sql')).toBeNull();
    expect(parseMigrationFilename('20260418091500_add_post_index.sql')).toBeNull();
    expect(parseMigrationFilename('20260418091500_AddPostIndex.sql')).toBeNull();
    expect(parseMigrationFilename('20260418091500 add-post-index.sql')).toBeNull();
  });
});

describe('assertValidMigrationVersion', () => {
  it('accepts a timestamp-formatted migration version', () => {
    expect(() => assertValidMigrationVersion('20260418091500')).not.toThrow();
  });

  it('rejects invalid migration versions', () => {
    expect(() => assertValidMigrationVersion('20260418')).toThrow(/invalid migration version/i);
    expect(() => assertValidMigrationVersion('../20260418091500')).toThrow(
      /invalid migration version/i,
    );
  });
});

describe('compareMigrationVersions', () => {
  it('orders versions lexicographically by time', () => {
    expect(compareMigrationVersions('20260418091500', '20260418091501')).toBeLessThan(0);
  });
});

describe('getRemoteMigrationVersionStatus', () => {
  it('treats exact remote matches as already applied', () => {
    expect(
      getRemoteMigrationVersionStatus(
        '20260418091500',
        new Set(['20260418091500', '20260418091600']),
        '20260418091600',
      ),
    ).toBe('already-applied');
  });

  it('treats versions older than remote head as older-than-head when not applied', () => {
    expect(
      getRemoteMigrationVersionStatus(
        '19990101000000',
        new Set(['20260418091500', '20260418091600']),
        '20260418091600',
      ),
    ).toBe('older-than-head');
  });

  it('treats newer versions as pending', () => {
    expect(
      getRemoteMigrationVersionStatus(
        '20260418091700',
        new Set(['20260418091500', '20260418091600']),
        '20260418091600',
      ),
    ).toBe('pending');
  });
});

describe('getNextLocalMigrationVersion', () => {
  it('uses the current time when it is newer than local and remote migrations', () => {
    expect(
      getNextLocalMigrationVersion(
        ['20260418091500_create-users.sql', '20260418091600_add-user-index.sql'].map((filename) =>
          parseMigrationFilename(filename)
        ).filter((migration): migration is NonNullable<typeof migration> => migration !== null),
        '20260418091400',
        new Date('2026-04-18T09:17:30.000Z')
      )
    ).toBe('20260418091730');
  });

  it('bumps the highest known version when needed', () => {
    expect(
      getNextLocalMigrationVersion(
        ['20260418091500_create-users.sql', '20260418091600_add-user-index.sql'].map((filename) =>
          parseMigrationFilename(filename)
        ).filter((migration): migration is NonNullable<typeof migration> => migration !== null),
        '20260418091600',
        new Date('2026-04-18T09:16:00.000Z')
      )
    ).toBe('20260418091601');
  });
});

describe('parseStrictLocalMigrations', () => {
  it('rejects invalid filenames', () => {
    expect(() =>
      parseStrictLocalMigrations(['20260418091500_create-users.sql', 'bad-file.sql'])
    ).toThrow(/invalid migration filename/i);
  });

  it('rejects duplicate versions', () => {
    expect(() =>
      parseStrictLocalMigrations([
        '20260418091500_create-users.sql',
        '20260418091500_create-accounts.sql',
      ])
    ).toThrow(/duplicate local migration version/i);
  });
});

describe('formatMigrationSql', () => {
  it('serializes stored statements into readable SQL', () => {
    expect(formatMigrationSql(['CREATE TABLE posts (id bigint)', 'CREATE INDEX posts_id_idx ON posts (id)']))
      .toBe('CREATE TABLE posts (id bigint);\n\nCREATE INDEX posts_id_idx ON posts (id);\n');
  });

  it('returns an empty string when all statements are blank', () => {
    expect(formatMigrationSql(['   ', '\n\t'])).toBe('');
  });
});

describe('findOlderThanHeadLocalMigrations', () => {
  it('finds local migrations older than remote head that are not applied', () => {
    const migrations = parseStrictLocalMigrations([
      '19990101000000_legacy-file.sql',
      '20260418091700_add-user-index.sql',
    ]);

    expect(
      findOlderThanHeadLocalMigrations(
        migrations,
        new Set(['20260418091500', '20260418091600']),
        '20260418091600',
      ),
    ).toEqual([
      {
        filename: '19990101000000_legacy-file.sql',
        version: '19990101000000',
        name: 'legacy-file',
      },
    ]);
  });
});

describe('incrementMigrationVersion', () => {
  it('increments to the next second', () => {
    expect(incrementMigrationVersion('20260418235959')).toBe('20260419000000');
  });
});

describe('resolveMigrationTarget', () => {
  const filenames = ['20260418091500_create-users.sql', '20260418091600_add-user-index.sql'];

  it('resolves an exact filename target', () => {
    expect(resolveMigrationTarget('20260418091600_add-user-index.sql', filenames)).toEqual({
      filename: '20260418091600_add-user-index.sql',
      version: '20260418091600',
      name: 'add-user-index',
    });
  });

  it('resolves a version target', () => {
    expect(resolveMigrationTarget('20260418091500', filenames)).toEqual({
      filename: '20260418091500_create-users.sql',
      version: '20260418091500',
      name: 'create-users',
    });
  });

  it('fails when a version has no match', () => {
    expect(() => resolveMigrationTarget('20260418091700', filenames)).toThrow(/not found/i);
  });

  it('fails when a version is ambiguous', () => {
    expect(() =>
      resolveMigrationTarget('20260418091500', [
        '20260418091500_create-users.sql',
        '20260418091500_create-accounts.sql',
      ])
    ).toThrow(/multiple local migration files/i);
  });

  it('uses the exact filename target even when another file shares the version', () => {
    expect(
      resolveMigrationTarget('20260418091500_create-accounts.sql', [
        '20260418091500_create-users.sql',
        '20260418091500_create-accounts.sql',
      ])
    ).toEqual({
      filename: '20260418091500_create-accounts.sql',
      version: '20260418091500',
      name: 'create-accounts',
    });
  });
});

describe('findLocalMigrationByVersion', () => {
  it('returns the unique match for a version', () => {
    expect(
      findLocalMigrationByVersion('20260418091500', [
        '20260418091500_create-users.sql',
        '20260418091600_add-user-index.sql',
      ])
    ).toEqual({
      filename: '20260418091500_create-users.sql',
      version: '20260418091500',
      name: 'create-users',
    });
  });
});
