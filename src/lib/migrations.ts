import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLIError } from './errors.js';

export interface ParsedMigrationFile {
  filename: string;
  sequenceNumber: number;
  name: string;
}

const MIGRATION_FILENAME_REGEX = /^([1-9][0-9]*)_([a-z0-9-]+)\.sql$/;

export function parseMigrationFilename(filename: string): ParsedMigrationFile | null {
  const match = MIGRATION_FILENAME_REGEX.exec(filename);
  if (!match) {
    return null;
  }

  return {
    filename,
    sequenceNumber: Number(match[1]),
    name: match[2],
  };
}

export function getMigrationsDir(cwd: string = process.cwd()): string {
  return join(cwd, '.insforge', 'migrations');
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
        `Invalid migration filename: ${filename}. Expected <sequence_number>_<migration-name>.sql.`,
      );
    }
    return parsedMigration;
  });

  assertNoDuplicateMigrationSequences(migrations);
  return migrations.sort((left, right) => left.sequenceNumber - right.sequenceNumber);
}

export function assertNoDuplicateMigrationSequences(migrations: ParsedMigrationFile[]): void {
  const seen = new Set<number>();

  for (const migration of migrations) {
    if (seen.has(migration.sequenceNumber)) {
      throw new CLIError(`Duplicate local migration sequence found: ${migration.sequenceNumber}`);
    }
    seen.add(migration.sequenceNumber);
  }
}

export function getNextLocalMigrationSequence(
  migrations: ParsedMigrationFile[],
  latestRemoteSequenceNumber: number,
): number {
  const orderedMigrations = [...migrations].sort((left, right) => left.sequenceNumber - right.sequenceNumber);
  assertNoDuplicateMigrationSequences(orderedMigrations);

  let expectedSequenceNumber = latestRemoteSequenceNumber + 1;

  for (const migration of orderedMigrations) {
    if (migration.sequenceNumber <= latestRemoteSequenceNumber) {
      continue;
    }

    if (migration.sequenceNumber !== expectedSequenceNumber) {
      throw new CLIError(
        `Local pending migrations must be contiguous after remote sequence ${latestRemoteSequenceNumber}.`,
      );
    }

    expectedSequenceNumber += 1;
  }

  return expectedSequenceNumber;
}

export function formatMigrationSql(statements: string[]): string {
  return statements
    .map((statement) => statement.trim().replace(/;\s*$/u, ''))
    .filter(Boolean)
    .join(';\n\n')
    .concat(statements.length > 0 ? ';\n' : '');
}

export function findLocalMigrationBySequence(
  sequenceNumber: number,
  filenames: string[],
): ParsedMigrationFile {
  const matches = filenames
    .map((filename) => parseMigrationFilename(filename))
    .filter(
      (migration): migration is ParsedMigrationFile =>
        migration !== null && migration.sequenceNumber === sequenceNumber,
    );

  if (matches.length === 0) {
    throw new CLIError(`Local migration for sequence ${sequenceNumber} not found.`);
  }

  if (matches.length > 1) {
    throw new CLIError(
      `Multiple local migration files found for sequence ${sequenceNumber}.`,
    );
  }

  return matches[0];
}

export function resolveMigrationTarget(
  target: string,
  filenames: string[],
): ParsedMigrationFile {
  if (/^[1-9][0-9]*$/u.test(target)) {
    return findLocalMigrationBySequence(Number(target), filenames);
  }

  const parsedTarget = parseMigrationFilename(target);
  if (!parsedTarget) {
    throw new CLIError(
      'Migration file names must match <sequence_number>_<migration-name>.sql.',
    );
  }

  if (!filenames.includes(target)) {
    throw new CLIError(`Local migration file not found: ${target}`);
  }

  return findLocalMigrationBySequence(parsedTarget.sequenceNumber, filenames);
}
