import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Command } from 'commander';
import { getProjectConfig } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { mimeTypeFromName } from '../../lib/mime.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

/**
 * Resolve the content type for an upload: an explicit (non-empty) `--content-type`
 * wins, otherwise infer from the file extension, otherwise fall back to the
 * storage default. Exported for testing.
 */
export function resolveUploadContentType(filePath: string, explicit?: string): string {
  return explicit?.trim() || mimeTypeFromName(filePath) || 'application/octet-stream';
}

export function registerStorageUploadCommand(storageCmd: Command): void {
  storageCmd
    .command('upload <file>')
    .description('Upload a file to a storage bucket')
    .requiredOption('--bucket <name>', 'Target bucket name')
    .option('--key <objectKey>', 'Object key (defaults to filename)')
    .option('--content-type <type>', 'MIME type to store (defaults to one inferred from the file extension)')
    .action(async (file: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();

        if (!existsSync(file)) {
          throw new CLIError(`File not found: ${file}`);
        }

        const fileContent = readFileSync(file);
        const objectKey = opts.key ?? basename(file);
        const bucketName = opts.bucket;

        // Resolve the content type: explicit flag wins, then infer from the
        // file's extension. Without this a typeless Blob is stored as
        // application/octet-stream regardless of the actual file type.
        const contentType = resolveUploadContentType(file, opts.contentType);

        // Build multipart form data. The Blob's type becomes the multipart
        // part's Content-Type, which the backend stores as the object's MIME type.
        const formData = new FormData();
        const blob = new Blob([fileContent], { type: contentType });
        formData.append('file', blob, objectKey);

        // PUT /api/storage/buckets/{bucket}/objects/{key} for named upload
        const url = `${config.oss_host}/api/storage/buckets/${encodeURIComponent(bucketName)}/objects/${encodeURIComponent(objectKey)}`;

        const res = await fetch(url, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${config.api_key}`,
          },
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          throw new CLIError(err.error ?? `Upload failed: ${res.status}`);
        }

        const data = await res.json();

        await trackCommandUsage('storage', 'upload', true);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Uploaded "${basename(file)}" to bucket "${bucketName}".`);
        }
      } catch (err) {
        await trackCommandUsage('storage', 'upload', false, {}, err);
        handleError(err, json);
      }
    });
}
