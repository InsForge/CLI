import type { Command } from 'commander';
import * as prompts from '../../lib/prompts.js';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';

export function registerStorageDeleteBucketCommand(storageCmd: Command): void {
  storageCmd
    .command('delete-bucket <name>')
    .description('Delete a storage bucket and all its objects')
    .action(async (name: string, _opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        await requireAuth();

        if (!yes && !json) {
          const confirm = await prompts.confirm({
            message: `Delete bucket "${name}" and all its objects? This cannot be undone.`,
          });
          if (prompts.isCancel(confirm) || !confirm) {
            process.exit(0);
          }
        }

        const res = await ossFetch(`/api/storage/buckets/${encodeURIComponent(name)}`, {
          method: 'DELETE',
        });

        const data = await res.json();

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Bucket "${name}" deleted.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
