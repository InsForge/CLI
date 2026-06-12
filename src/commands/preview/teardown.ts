import type { Command } from 'commander';
import path from 'node:path';
import { existsSync, copyFileSync, rmSync } from 'node:fs';
import { deleteBranchApi } from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { outputInfo, outputJson } from '../../lib/output.js';
import { shutdownAnalytics } from '../../lib/analytics.js';
import { readPreviewManifest, deletePreviewManifest } from '../../lib/preview-manifest.js';

export function registerPreviewTeardownCommand(preview: Command): void {
  preview
    .command('teardown <name>')
    .description('Delete a preview environment created by `preview create` (experimental)')
    .action(async (name: string, _opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const manifest = await readPreviewManifest(process.cwd(), name);
        if (!manifest) {
          throw new CLIError(`No preview named '${name}' found in this directory.`);
        }
        await deleteBranchApi(manifest.branchId, apiUrl);

        // The branch is now gone (irreversible). Finish local cleanup defensively
        // so a failure restoring the env file never aborts before the manifest is
        // removed — otherwise the manifest would keep pointing at a deleted branch.
        if (manifest.wiredEnvFile) {
          try {
            const envPath = path.resolve(process.cwd(), manifest.wiredEnvFile);
            const backupPath = envPath + '.preview-bak';
            if (manifest.wiredEnvCreated) {
              // We created this file during `--wire-env`; remove it rather than
              // leave it pointing at a deleted preview backend.
              rmSync(envPath, { force: true });
              outputInfo(`  Removed ${manifest.wiredEnvFile} (created by preview).`);
            } else if (existsSync(backupPath)) {
              copyFileSync(backupPath, envPath);
              rmSync(backupPath, { force: true });
              outputInfo(`  Restored ${manifest.wiredEnvFile} from backup.`);
            }
          } catch (envErr) {
            const msg = envErr instanceof Error ? envErr.message : String(envErr);
            outputInfo(`  ⚠ Could not restore ${manifest.wiredEnvFile} (${msg}). Restore it manually.`);
          }
        }

        await deletePreviewManifest(process.cwd(), name);
        if (json) outputJson({ teardown: { name, ok: true } });
        else outputInfo(`Preview '${name}' torn down.`);
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
