import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import {
  ensureMigrationsDir,
  formatMigrationSql,
  getMigrationsDir,
  getNextLocalMigrationSequence,
  listLocalMigrationFilenames,
  parseStrictLocalMigrations,
  resolveMigrationTarget,
} from '../../lib/migrations.js';
import { outputJson, outputSuccess, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import type {
  CreateMigrationRequest,
  CreateMigrationResponse,
  DatabaseMigrationsResponse,
  Migration,
} from '../../types.js';

function getLatestRemoteSequenceNumber(migrations: Migration[]): number {
  return migrations.reduce(
    (latestSequenceNumber, migration) =>
      Math.max(latestSequenceNumber, migration.sequenceNumber),
    0,
  );
}

function buildMigrationFilename(sequenceNumber: number, name: string): string {
  return `${sequenceNumber}_${name}.sql`;
}

function formatCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? createdAt : date.toLocaleString();
}

async function fetchRemoteMigrations(): Promise<Migration[]> {
  const res = await ossFetch('/api/database/migrations');
  const raw = (await res.json()) as DatabaseMigrationsResponse;
  return Array.isArray(raw.migrations) ? raw.migrations : [];
}

function assertValidMigrationName(name: string): void {
  if (!/^[a-z0-9-]+$/u.test(name)) {
    throw new CLIError('Migration name must use lowercase letters, numbers, and hyphens only.');
  }
}

export function registerDbMigrationsCommand(dbCmd: Command): void {
  const migrationsCmd = dbCmd.command('migrations').description('Manage database migration files');

  migrationsCmd
    .command('list')
    .description('List applied remote database migrations')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const migrations = await fetchRemoteMigrations();

        if (json) {
          outputJson({ migrations });
        } else if (migrations.length === 0) {
          console.log('No database migrations found.');
        } else {
          outputTable(
            ['Sequence', 'Name', 'Created At'],
            migrations.map((migration) => [
              String(migration.sequenceNumber),
              migration.name,
              formatCreatedAt(migration.createdAt),
            ]),
          );
        }

        await reportCliUsage('cli.db.migrations.list', true);
      } catch (err) {
        await reportCliUsage('cli.db.migrations.list', false);
        handleError(err, json);
      }
    });

  migrationsCmd
    .command('fetch')
    .description('Fetch applied remote migrations into .insforge/migrations/')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const migrations = await fetchRemoteMigrations();
        const migrationsDir = ensureMigrationsDir();
        const createdFiles: string[] = [];
        const skippedFiles: string[] = [];

        for (const migration of [...migrations].sort(
          (left, right) => left.sequenceNumber - right.sequenceNumber,
        )) {
          const filename = buildMigrationFilename(
            migration.sequenceNumber,
            migration.name,
          );
          const filePath = join(migrationsDir, filename);

          if (existsSync(filePath)) {
            skippedFiles.push(filename);
            continue;
          }

          writeFileSync(filePath, formatMigrationSql(migration.statements));
          createdFiles.push(filename);
        }

        if (json) {
          outputJson({
            directory: migrationsDir,
            totalRemoteMigrations: migrations.length,
            createdFiles,
            skippedFiles,
          });
        } else {
          outputSuccess(
            `Fetched ${migrations.length} remote migration(s) into ${migrationsDir}.`,
          );
          console.log(`Created: ${createdFiles.length}`);
          console.log(`Skipped: ${skippedFiles.length}`);
        }

        await reportCliUsage('cli.db.migrations.fetch', true);
      } catch (err) {
        await reportCliUsage('cli.db.migrations.fetch', false);
        handleError(err, json);
      }
    });

  migrationsCmd
    .command('new <migration-name>')
    .description('Create a new local migration file')
    .action(async (migrationName: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        assertValidMigrationName(migrationName);

        const migrations = await fetchRemoteMigrations();
        const latestRemoteSequenceNumber = getLatestRemoteSequenceNumber(migrations);
        const localMigrations = parseStrictLocalMigrations(listLocalMigrationFilenames());
        const nextSequenceNumber = getNextLocalMigrationSequence(
          localMigrations,
          latestRemoteSequenceNumber,
        );

        const filename = buildMigrationFilename(nextSequenceNumber, migrationName);
        const migrationsDir = ensureMigrationsDir();
        const filePath = join(migrationsDir, filename);

        if (existsSync(filePath)) {
          throw new CLIError(`Migration file already exists: ${filename}`);
        }

        writeFileSync(filePath, '');

        if (json) {
          outputJson({ filename, path: filePath, sequenceNumber: nextSequenceNumber });
        } else {
          outputSuccess(`Created migration file ${filename}`);
        }

        await reportCliUsage('cli.db.migrations.new', true);
      } catch (err) {
        await reportCliUsage('cli.db.migrations.new', false);
        handleError(err, json);
      }
    });

  migrationsCmd
    .command('up <target>')
    .description('Apply exactly one local migration file')
    .action(async (target: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const migrations = await fetchRemoteMigrations();
        const latestRemoteSequenceNumber = getLatestRemoteSequenceNumber(migrations);
        const filenames = listLocalMigrationFilenames();
        const targetMigration = resolveMigrationTarget(target, filenames);

        if (targetMigration.sequenceNumber <= latestRemoteSequenceNumber) {
          throw new CLIError(
            `Migration ${targetMigration.filename} is already applied remotely.`,
          );
        }

        if (targetMigration.sequenceNumber !== latestRemoteSequenceNumber + 1) {
          throw new CLIError(
            `Migration ${targetMigration.filename} is not the next remote sequence. Expected ${latestRemoteSequenceNumber + 1}.`,
          );
        }

        const filePath = join(getMigrationsDir(), targetMigration.filename);
        if (!existsSync(filePath)) {
          throw new CLIError(`Local migration file not found: ${targetMigration.filename}`);
        }

        const sql = readFileSync(filePath, 'utf-8');
        if (!sql.trim()) {
          throw new CLIError(`Migration file is empty: ${targetMigration.filename}`);
        }

        const body: CreateMigrationRequest = {
          name: targetMigration.name,
          sql,
        };

        const res = await ossFetch('/api/database/migrations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const createdMigration = (await res.json()) as CreateMigrationResponse;

        if (createdMigration.sequenceNumber !== targetMigration.sequenceNumber) {
          throw new CLIError(
            `Applied migration sequence mismatch. Expected ${targetMigration.sequenceNumber}, received ${createdMigration.sequenceNumber}.`,
          );
        }

        if (json) {
          outputJson(createdMigration);
        } else {
          outputSuccess(`Applied migration ${targetMigration.filename}`);
        }

        await reportCliUsage('cli.db.migrations.up', true);
      } catch (err) {
        await reportCliUsage('cli.db.migrations.up', false);
        handleError(err, json);
      }
    });
}
