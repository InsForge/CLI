import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { listS3AccessKeys, createS3AccessKey, deleteS3AccessKey } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable, outputSuccess, outputInfo } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerStorageS3KeysCommand(storageCmd: Command): void {
  const s3Cmd = storageCmd
    .command('s3-keys')
    .description('Manage S3-compatible access keys for storage');

  s3Cmd
    .command('list')
    .description('List S3 access keys (secrets are not shown)')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        const keys = await listS3AccessKeys();
        await trackCommandUsage('storage', 's3-keys list', true, {
          result_count: keys.length,
        });
        if (json) {
          outputJson(keys);
        } else if (!keys.length) {
          outputInfo('No S3 access keys found.');
        } else {
          outputTable(
            ['ID', 'Access Key ID', 'Description', 'Last Used', 'Created'],
            keys.map((k) => [
              k.id,
              k.accessKeyId,
              k.description ?? '-',
              k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never',
              new Date(k.createdAt).toLocaleString(),
            ]),
          );
        }
        await reportCliUsage('cli.storage.s3-keys.list', true);
      } catch (err) {
        await reportCliUsage('cli.storage.s3-keys.list', false);
        await trackCommandUsage('storage', 's3-keys list', false, {}, err);
        handleError(err, json);
      }
    });

  s3Cmd
    .command('create')
    .description('Create an S3 access key (secret shown once)')
    .option('--description <text>', 'Label for the key (max 200 chars)')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();
        const key = await createS3AccessKey(opts.description);
        await trackCommandUsage('storage', 's3-keys create', true);
        if (json) {
          outputJson(key);
        } else {
          outputSuccess('S3 access key created (secret shown once — store it now):');
          outputInfo(`\nAccess Key ID:     ${key.accessKeyId}`);
          outputInfo(`Secret Access Key: ${key.secretAccessKey}`);
        }
        await reportCliUsage('cli.storage.s3-keys.create', true);
      } catch (err) {
        await reportCliUsage('cli.storage.s3-keys.create', false);
        await trackCommandUsage('storage', 's3-keys create', false, {}, err);
        handleError(err, json);
      }
    });

  s3Cmd
    .command('delete <id>')
    .description('Delete an S3 access key')
    .action(async (id: string, _opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        await requireAuth();
        if (!yes && !json) {
          const confirmed = await clack.confirm({
            message: `Delete S3 access key ${id}? Tools using it will stop working.`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }
        await deleteS3AccessKey(id);
        await trackCommandUsage('storage', 's3-keys delete', true);
        if (json) {
          outputJson({ deleted: true, id });
        } else {
          outputSuccess(`S3 access key ${id} deleted.`);
        }
        await reportCliUsage('cli.storage.s3-keys.delete', true);
      } catch (err) {
        await reportCliUsage('cli.storage.s3-keys.delete', false);
        await trackCommandUsage('storage', 's3-keys delete', false, {}, err);
        handleError(err, json);
      }
    });
}
