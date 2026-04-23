import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLIError } from './errors.js';

export interface ParsedMigrationFile {
  filename: string;
  version: string;
  name: string;
}

export type RemoteMigrationVersionStatus = 'already-applied' | 'older-than-head' | 'pending';

// Cap at 64 digits so unbounded input can't DoS BigInt conversions or
// the backend's `version::numeric` casts. 64 comfortably fits 4-digit
// Drizzle sequences, 14-digit YYYYMMDDHHmmss timestamps, and anything
// realistic in between.
const MIGRATION_VERSION_REGEX = /^\d{1,64}$/u;
const MIGRATION_FILENAME_REGEX = /^(\d{1,64})_([a-z0-9-]+)\.sql$/u;

export function assertValidMigrationVersion(version: string): void {
  if (!MIGRATION_VERSION_REGEX.test(version)) {
    throw new CLIError(`Invalid migration version: ${version}. Expected a numeric string of at most 64 digits (e.g. 0001 or 20260418091500).`);
  }
}

// Numeric prefixes like "0001" and "1" refer to the same migration. Strip
// leading zeros so Set lookups, equality checks, and duplicate detection all
// agree with the numeric ordering in compareMigrationVersions.
export function canonicalMigrationVersion(version: string): string {
  assertValidMigrationVersion(version);
  return BigInt(version).toString();
}

export function parseMigrationFilename(filename: string): ParsedMigrationFile | null {
  const match = MIGRATION_FILENAME_REGEX.exec(filename);
  if (!match) {
    return null;
  }

  return {
    filename,
    version: canonicalMigrationVersion(match[1]),
    name: match[2],
  };
}

export function compareMigrationVersions(left: string, right: string): number {
  if (MIGRATION_VERSION_REGEX.test(left) && MIGRATION_VERSION_REGEX.test(right)) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return left.localeCompare(right);
}

export function getRemoteMigrationVersionStatus(
  version: string,
  appliedVersions: ReadonlySet<string>,
  latestRemoteVersion: string | null,
): RemoteMigrationVersionStatus {
  if (appliedVersions.has(version)) {
    return 'already-applied';
  }

  if (
    latestRemoteVersion &&
    compareMigrationVersions(version, latestRemoteVersion) < 0
  ) {
    return 'older-than-head';
  }

  return 'pending';
}

function formatMigrationVersion(date: Date): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');

  return `${year}${month}${day}${hour}${minute}${second}`;
}

export function incrementMigrationVersion(version: string): string {
  assertValidMigrationVersion(version);
  if (!/^\d{14}$/u.test(version)) {
    return String(BigInt(version) + 1n);
  }
  const year = Number(version.slice(0, 4));
  const month = Number(version.slice(4, 6)) - 1;
  const day = Number(version.slice(6, 8));
  const hour = Number(version.slice(8, 10));
  const minute = Number(version.slice(10, 12));
  const second = Number(version.slice(12, 14));
  const nextTimestamp = Date.UTC(year, month, day, hour, minute, second + 1);

  return formatMigrationVersion(new Date(nextTimestamp));
}

export function getMigrationsDir(cwd: string = process.cwd()): string {
  return join(cwd, 'migrations');
}

export function ensureMigrationsDir(cwd: string = process.cwd()): string {
  const migrationsDir = getMigrationsDir(cwd);
  if (!existsSync(migrationsDir)) {
    mkdirSync(migrationsDir, { recursive: true });
  }
  return migrationsDir;
}

export function listLocalMigrationFilenames(cwd: string = process.cwd()): string[] {
  const migrationsDir = getMigrationsDir(cwd);
  if (!existsSync(migrationsDir)) {
    return [];
  }

  return readdirSync(migrationsDir).sort((left, right) => left.localeCompare(right));
}

export function parseStrictLocalMigrations(filenames: string[]): ParsedMigrationFile[] {
  const migrations = filenames.map((filename) => {
    const parsedMigration = parseMigrationFilename(filename);
    if (!parsedMigration) {
      throw new CLIError(
        `Invalid migration filename: ${filename}. Expected <migration_version>_<migration-name>.sql.`,
      );
    }
    return parsedMigration;
  });

  assertNoDuplicateMigrationVersions(migrations);
  return migrations.sort((left, right) => compareMigrationVersions(left.version, right.version));
}

export function assertNoDuplicateMigrationVersions(migrations: ParsedMigrationFile[]): void {
  const seen = new Set<string>();

  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new CLIError(`Duplicate local migration version found: ${migration.version}`);
    }
    seen.add(migration.version);
  }
}

export function getNextLocalMigrationVersion(
  migrations: ParsedMigrationFile[],
  latestRemoteVersion: string | null,
  now: Date = new Date(),
): string {
  const orderedMigrations = [...migrations].sort((left, right) =>
    compareMigrationVersions(left.version, right.version),
  );
  assertNoDuplicateMigrationVersions(orderedMigrations);

  const latestKnownVersion = orderedMigrations.reduce<string | null>(
    (latestVersion, migration) => {
      if (!latestVersion || compareMigrationVersions(migration.version, latestVersion) > 0) {
        return migration.version;
      }
      return latestVersion;
    },
    latestRemoteVersion,
  );

  const currentVersion = formatMigrationVersion(now);
  if (!latestKnownVersion || compareMigrationVersions(currentVersion, latestKnownVersion) > 0) {
    return currentVersion;
  }

  return incrementMigrationVersion(latestKnownVersion);
}

export function formatMigrationSql(statements: string[]): string {
  const normalizedStatements = statements
    .map((statement) => statement.trim().replace(/;\s*$/u, ''))
    .filter(Boolean);

  return normalizedStatements
    .join(';\n\n')
    .concat(normalizedStatements.length > 0 ? ';\n' : '');
}

export function findOlderThanHeadLocalMigrations(
  migrations: ParsedMigrationFile[],
  appliedVersions: ReadonlySet<string>,
  latestRemoteVersion: string | null,
): ParsedMigrationFile[] {
  return migrations.filter(
    (migration) =>
      getRemoteMigrationVersionStatus(
        migration.version,
        appliedVersions,
        latestRemoteVersion,
      ) === 'older-than-head',
  );
}

export function findLocalMigrationByVersion(
  version: string,
  filenames: string[],
): ParsedMigrationFile {
  const canonicalVersion = canonicalMigrationVersion(version);
  const matches = filenames
    .map((filename) => parseMigrationFilename(filename))
    .filter(
      (migration): migration is ParsedMigrationFile =>
        migration !== null && migration.version === canonicalVersion,
    );

  if (matches.length === 0) {
    throw new CLIError(`Local migration for version ${version} not found.`);
  }

  if (matches.length > 1) {
    throw new CLIError(
      `Multiple local migration files found for version ${version}.`,
    );
  }

  return matches[0];
}

export function resolveMigrationTarget(
  target: string,
  filenames: string[],
): ParsedMigrationFile {
  if (/^\d{1,64}$/u.test(target)) {
    return findLocalMigrationByVersion(target, filenames);
  }

  const parsedTarget = parseMigrationFilename(target);
  if (!parsedTarget) {
    throw new CLIError(
      'Migration file names must match <migration_version>_<migration-name>.sql.',
    );
  }

  if (!filenames.includes(target)) {
    throw new CLIError(`Local migration file not found: ${target}`);
  }

  return parsedTarget;
}
