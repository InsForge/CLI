import { describe, expect, it } from 'vitest';
import {
  assertValidMigrationVersion,
  canonicalMigrationVersion,
  compareMigrationVersions,
  findLocalMigrationByVersion,
  findOlderThanHeadLocalMigrations,
  formatMigrationSql,
  getMigrationsDir,
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

  it('accepts any numeric prefix (e.g. Drizzle-style) and canonicalizes the version', () => {
    expect(parseMigrationFilename('0001_add-post-index.sql')).toEqual({
      filename: '0001_add-post-index.sql',
      version: '1',
      name: 'add-post-index',
    });
    expect(parseMigrationFilename('42_add-post-index.sql')).toEqual({
      filename: '42_add-post-index.sql',
      version: '42',
      name: 'add-post-index',
    });
  });

  it('rejects invalid migration filenames', () => {
    expect(parseMigrationFilename('20260418091500_add_post_index.sql')).toBeNull();
    expect(parseMigrationFilename('20260418091500_AddPostIndex.sql')).toBeNull();
    expect(parseMigrationFilename('20260418091500 add-post-index.sql')).toBeNull();
    expect(parseMigrationFilename('abc_add-post-index.sql')).toBeNull();
    expect(parseMigrationFilename('_add-post-index.sql')).toBeNull();
  });
});

describe('canonicalMigrationVersion', () => {
  it('strips leading zeros so padded numeric prefixes match unpadded ones', () => {
    expect(canonicalMigrationVersion('0001')).toBe('1');
    expect(canonicalMigrationVersion('00042')).toBe('42');
    expect(canonicalMigrationVersion('1')).toBe('1');
    expect(canonicalMigrationVersion('0')).toBe('0');
  });

  it('leaves 14-digit timestamps unchanged', () => {
    expect(canonicalMigrationVersion('20260418091500')).toBe('20260418091500');
  });

  it('throws on non-numeric input', () => {
    expect(() => canonicalMigrationVersion('abc')).toThrow(/invalid migration version/i);
    expect(() => canonicalMigrationVersion('../1')).toThrow(/invalid migration version/i);
  });
});

describe('assertValidMigrationVersion', () => {
  it('accepts any pure-digit migration version', () => {
    expect(() => assertValidMigrationVersion('20260418091500')).not.toThrow();
    expect(() => assertValidMigrationVersion('20260418')).not.toThrow();
    expect(() => assertValidMigrationVersion('0001')).not.toThrow();
    expect(() => assertValidMigrationVersion('42')).not.toThrow();
  });

  it('rejects non-numeric or unsafe migration versions', () => {
    expect(() => assertValidMigrationVersion('../20260418091500')).toThrow(
      /invalid migration version/i,
    );
    expect(() => assertValidMigrationVersion('abc')).toThrow(/invalid migration version/i);
    expect(() => assertValidMigrationVersion('')).toThrow(/invalid migration version/i);
  });

  it('rejects versions longer than 64 digits', () => {
    expect(() => assertValidMigrationVersion('9'.repeat(65))).toThrow(
      /invalid migration version/i,
    );
    expect(() => assertValidMigrationVersion('9'.repeat(64))).not.toThrow();
  });
});

describe('compareMigrationVersions', () => {
  it('orders timestamp versions by time', () => {
    expect(compareMigrationVersions('20260418091500', '20260418091501')).toBeLessThan(0);
  });

  it('orders numeric versions of different widths numerically, not lexicographically', () => {
    expect(compareMigrationVersions('2', '10')).toBeLessThan(0);
    expect(compareMigrationVersions('0002', '0010')).toBeLessThan(0);
  });

  it('orders a short numeric prefix before a timestamp', () => {
    expect(compareMigrationVersions('0001', '20260418091500')).toBeLessThan(0);
  });
});

describe('getMigrationsDir', () => {
  it('stores migration files in a top-level migrations directory', () => {
    expect(getMigrationsDir('/tmp/project')).toBe('/tmp/project/migrations');
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

  it('treats padded and unpadded numeric prefixes of the same value as duplicates', () => {
    expect(() =>
      parseStrictLocalMigrations(['0001_create-users.sql', '1_create-accounts.sql'])
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

  it('increments a non-timestamp numeric version via BigInt', () => {
    expect(incrementMigrationVersion('1')).toBe('2');
    expect(incrementMigrationVersion('9')).toBe('10');
  });

  it('throws CLIError (not SyntaxError) on invalid input', () => {
    expect(() => incrementMigrationVersion('abc')).toThrow(/invalid migration version/i);
    expect(() => incrementMigrationVersion('9'.repeat(65))).toThrow(
      /invalid migration version/i,
    );
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

  it('resolves a padded numeric target against an unpadded filename and vice versa', () => {
    expect(resolveMigrationTarget('0001', ['1_create-users.sql'])).toEqual({
      filename: '1_create-users.sql',
      version: '1',
      name: 'create-users',
    });
    expect(resolveMigrationTarget('1', ['0001_create-users.sql'])).toEqual({
      filename: '0001_create-users.sql',
      version: '1',
      name: 'create-users',
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
