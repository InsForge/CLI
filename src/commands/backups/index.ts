import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import {
  listBackups,
  getLatestBackup,
  createBackup,
  renameBackup,
  deleteBackup,
  restoreBackup,
} from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { getProjectId } from '../../lib/config.js';
import { outputJson, outputTable, outputSuccess, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import type { Backup } from '../../types.js';

function resolveProjectId(opts: { project?: string }): string {
  const id = getProjectId(opts.project);
  if (!id) {
    throw new CLIError('No project specified. Pass --project <id> or run `insforge link` first.');
  }
  return id;
}

function formatBytes(n: number | null): string {
  if (n === null) return '-';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function backupRow(b: Backup): string[] {
  return [
    b.id,
    b.name ?? '-',
    b.status,
    b.trigger_source,
    formatBytes(b.size_bytes),
    new Date(b.created_at).toLocaleString(),
  ];
}

const BACKUP_HEADERS = ['ID', 'Name', 'Status', 'Source', 'Size', 'Created'];

export function registerBackupsCommands(backupsCmd: Command): void {
  backupsCmd
    .command('list')
    .description('List project backups')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);
        const backups = await listBackups(projectId, apiUrl);
        if (json) {
          outputJson(backups);
        } else if (!backups.length) {
          outputInfo('No backups found.');
        } else {
          outputTable(BACKUP_HEADERS, backups.map(backupRow));
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  backupsCmd
    .command('latest')
    .description('Show the most recent backup')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);
        const latest = await getLatestBackup(projectId, apiUrl);
        if (json) {
          outputJson(latest);
        } else if (!latest) {
          outputInfo('No backups found.');
        } else {
          outputInfo(`File:     ${latest.file}`);
          outputInfo(`Size:     ${formatBytes(latest.size_bytes)}`);
          outputInfo(`Download: ${latest.download_url}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  backupsCmd
    .command('create')
    .description('Create a new backup')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .option('--name <name>', 'Backup name (1–64 characters)')
    .option('--wait', 'Wait for the backup to finish instead of returning while it is queued')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);
        const result = await createBackup(projectId, opts.name, !!opts.wait, apiUrl);
        captureEvent(projectId, 'cli_backup_create', { named: !!opts.name });
        if (json) {
          outputJson(result);
        } else {
          outputSuccess(result.message);
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });

  backupsCmd
    .command('rename <backupId> <name>')
    .description('Rename a backup (pass "" to clear the name)')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .action(async (backupId: string, name: string, opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);
        const result = await renameBackup(projectId, backupId, name === '' ? null : name, apiUrl);
        if (json) {
          outputJson(result);
        } else {
          outputSuccess(
            result.name
              ? `Backup ${backupId} renamed to "${result.name}".`
              : `Backup ${backupId} name cleared.`,
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  backupsCmd
    .command('delete <backupId>')
    .description('Delete a backup')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .action(async (backupId: string, opts, cmd) => {
      const { json, apiUrl, yes } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);

        if (!yes && !json) {
          const confirmed = await clack.confirm({ message: `Delete backup ${backupId}?` });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }

        await deleteBackup(projectId, backupId, apiUrl);
        captureEvent(projectId, 'cli_backup_delete', {});
        if (json) {
          outputJson({ deleted: true, backup_id: backupId });
        } else {
          outputSuccess(`Backup ${backupId} deleted.`);
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });

  backupsCmd
    .command('restore <backupId>')
    .description('Restore the project from a backup (overwrites current data)')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .action(async (backupId: string, opts, cmd) => {
      const { json, apiUrl, yes } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);

        if (!yes && !json) {
          const confirmed = await clack.confirm({
            message: `Restore from backup ${backupId}? This OVERWRITES the project's current database and storage.`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }

        await restoreBackup(projectId, backupId, apiUrl);
        captureEvent(projectId, 'cli_backup_restore', {});
        if (json) {
          outputJson({ restored: true, backup_id: backupId });
        } else {
          outputSuccess(`Restore from backup ${backupId} initiated.`);
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
