import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

export function registerStorageCreateBucketCommand(storageCmd: Command): void {
  storageCmd
    .command('create-bucket <name>')
    .description('Create a new storage bucket')
    .option('--public', 'Make the bucket publicly accessible (default)')
    .option('--private', 'Make the bucket private')
    .action(async (name: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const isPublic = !opts.private;

        const res = await ossFetch('/api/storage/buckets', {
          method: 'POST',
          body: JSON.stringify({ bucketName: name, isPublic }),
        });

        const data = await res.json();

        await trackCommandUsage('storage', 'create-bucket', true);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Bucket "${name}" created (${isPublic ? 'public' : 'private'}).`);
        }
        await reportCliUsage('cli.storage.create-bucket', true);
      } catch (err) {
        await reportCliUsage('cli.storage.create-bucket', false);
        await trackCommandUsage('storage', 'create-bucket', false, {}, err);
        handleError(err, json);
      }
    });
}
