import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import {
  compareMigrationVersions,
  ensureMigrationsDir,
  findOlderThanHeadLocalMigrations,
  formatMigrationSql,
  getMigrationsDir,
  getNextLocalMigrationVersion,
  getRemoteMigrationVersionStatus,
  listLocalMigrationFilenames,
  parseMigrationFilename,
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

function getLatestRemoteVersion(migrations: Migration[]): string | null {
  return migrations.reduce(
    (latestVersion, migration) =>
      !latestVersion || compareMigrationVersions(migration.version, latestVersion) > 0
        ? migration.version
        : latestVersion,
    null as string | null,
  );
}

function buildMigrationFilename(version: string, name: string): string {
  return `${version}_${name}.sql`;
}

function buildOlderThanHeadError(
  migrationLabel: string,
  latestRemoteVersion: string,
): CLIError {
  return new CLIError(
    `Migration ${migrationLabel} is older than the current remote head (${latestRemoteVersion}) and is not applied remotely. Rename it with a newer timestamp, or delete it locally if it is stale.`,
  );
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

async function applyMigration(
  targetMigration: Pick<Migration, 'version' | 'name'>,
  sql: string,
): Promise<CreateMigrationResponse> {
  const body: CreateMigrationRequest = {
    version: targetMigration.version,
    name: targetMigration.name,
    sql,
  };

  const res = await ossFetch('/api/database/migrations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const createdMigration = (await res.json()) as CreateMigrationResponse;

  if (createdMigration.version !== targetMigration.version) {
    throw new CLIError(
      `Applied migration version mismatch. Expected ${targetMigration.version}, received ${createdMigration.version}.`,
    );
  }

  return createdMigration;
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
            ['Version', 'Name', 'Created At'],
            migrations.map((migration) => [
              migration.version,
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
          (left, right) => compareMigrationVersions(left.version, right.version),
        )) {
          assertValidMigrationName(migration.name);

          const filename = buildMigrationFilename(
            migration.version,
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
        const latestRemoteVersion = getLatestRemoteVersion(migrations);
        const localMigrations = parseStrictLocalMigrations(listLocalMigrationFilenames());
        const nextVersion = getNextLocalMigrationVersion(
          localMigrations,
          latestRemoteVersion,
        );

        const filename = buildMigrationFilename(nextVersion, migrationName);
        const migrationsDir = ensureMigrationsDir();
        const filePath = join(migrationsDir, filename);

        if (existsSync(filePath)) {
          throw new CLIError(`Migration file already exists: ${filename}`);
        }

        writeFileSync(filePath, '');

        if (json) {
          outputJson({ filename, path: filePath, version: nextVersion });
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
    .command('up [target]')
    .description('Apply one or more local migration files')
    .option('--all', 'Apply all pending local migration files')
    .option('--to <version-or-filename>', 'Apply pending local migrations up to a version or file')
    .action(async (target: string | undefined, options, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const migrations = await fetchRemoteMigrations();
        const latestRemoteVersion = getLatestRemoteVersion(migrations);
        const appliedRemoteVersions = new Set(
          migrations.map((migration) => migration.version),
        );
        const filenames = listLocalMigrationFilenames();

        const requestedModes = [Boolean(target), Boolean(options.all), Boolean(options.to)].filter(Boolean);
        if (requestedModes.length !== 1) {
          throw new CLIError(
            'Use exactly one apply mode: `up <target>`, `up --to <version-or-filename>`, or `up --all`.',
          );
        }

        const applySingleTarget = async (targetMigrationFilenameOrVersion: string) => {
          const targetMigration = resolveMigrationTarget(targetMigrationFilenameOrVersion, filenames);
          const validLocalMigrations = filenames
            .map((filename) => parseMigrationFilename(filename))
            .filter((migration): migration is NonNullable<typeof migration> => migration !== null)
            .sort((left, right) => compareMigrationVersions(left.version, right.version));

          const targetRemoteStatus = getRemoteMigrationVersionStatus(
            targetMigration.version,
            appliedRemoteVersions,
            latestRemoteVersion,
          );

          if (targetRemoteStatus === 'already-applied') {
            throw new CLIError(`Migration ${targetMigration.filename} is already applied remotely.`);
          }

          if (targetRemoteStatus === 'older-than-head' && latestRemoteVersion) {
            throw buildOlderThanHeadError(targetMigration.filename, latestRemoteVersion);
          }

          const earlierPendingMigration = validLocalMigrations.find(
            (migration) =>
              migration.version !== targetMigration.version &&
              (!latestRemoteVersion ||
                compareMigrationVersions(migration.version, latestRemoteVersion) > 0) &&
              compareMigrationVersions(migration.version, targetMigration.version) < 0,
          );

          if (earlierPendingMigration) {
            throw new CLIError(
              `Migration ${targetMigration.filename} is not the next pending local migration. Apply ${earlierPendingMigration.filename} first, or fix/delete it locally if it is invalid or no longer needed.`,
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

          return applyMigration(targetMigration, sql);
        };

        let appliedMigrations: CreateMigrationResponse[] = [];

        if (target) {
          appliedMigrations = [await applySingleTarget(target)];
        } else {
          const localMigrations = parseStrictLocalMigrations(filenames);
          const olderThanHeadMigrations = findOlderThanHeadLocalMigrations(
            localMigrations,
            appliedRemoteVersions,
            latestRemoteVersion,
          );
          const pendingMigrations = localMigrations.filter(
            (migration) =>
              getRemoteMigrationVersionStatus(
                migration.version,
                appliedRemoteVersions,
                latestRemoteVersion,
              ) === 'pending',
          );

          if (olderThanHeadMigrations.length > 0 && latestRemoteVersion) {
            throw buildOlderThanHeadError(
              olderThanHeadMigrations[0].filename,
              latestRemoteVersion,
            );
          }

          if (pendingMigrations.length === 0) {
            if (json) {
              outputJson({ appliedMigrations: [] });
            } else {
              outputSuccess('No pending local migrations to apply.');
            }

            await reportCliUsage('cli.db.migrations.up', true);
            return;
          }

          let migrationsToApply = pendingMigrations;

          if (options.to) {
            const targetVersion = /^\d{14}$/u.test(options.to)
              ? options.to
              : resolveMigrationTarget(options.to, filenames).version;

            const targetRemoteStatus = getRemoteMigrationVersionStatus(
              targetVersion,
              appliedRemoteVersions,
              latestRemoteVersion,
            );

            if (targetRemoteStatus === 'already-applied') {
              throw new CLIError(`Migration ${options.to} is already applied remotely.`);
            }

            if (targetRemoteStatus === 'older-than-head' && latestRemoteVersion) {
              throw buildOlderThanHeadError(options.to, latestRemoteVersion);
            }

            migrationsToApply = pendingMigrations.filter(
              (migration) => compareMigrationVersions(migration.version, targetVersion) <= 0,
            );

            if (
              migrationsToApply.length === 0 ||
              migrationsToApply[migrationsToApply.length - 1]?.version !== targetVersion
            ) {
              throw new CLIError(
                `Pending local migration not found for target ${options.to}.`,
              );
            }
          }

          for (const migration of migrationsToApply) {
            const filePath = join(getMigrationsDir(), migration.filename);
            if (!existsSync(filePath)) {
              throw new CLIError(`Local migration file not found: ${migration.filename}`);
            }

            const sql = readFileSync(filePath, 'utf-8');
            if (!sql.trim()) {
              throw new CLIError(`Migration file is empty: ${migration.filename}`);
            }

            appliedMigrations.push(await applyMigration(migration, sql));
          }
        }

        if (json) {
          outputJson({ appliedMigrations });
        } else {
          outputSuccess(`Applied ${appliedMigrations.length} migration file(s).`);
          for (const migration of appliedMigrations) {
            console.log(`- ${buildMigrationFilename(migration.version, migration.name)}`);
          }
        }

        await reportCliUsage('cli.db.migrations.up', true);
      } catch (err) {
        await reportCliUsage('cli.db.migrations.up', false);
        handleError(err, json);
      }
    });
}
