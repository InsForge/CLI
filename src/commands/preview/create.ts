import type { Command } from 'commander';
import path from 'node:path';
import { existsSync, copyFileSync } from 'node:fs';
import { createBranchApi, getBranchApi } from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { outputJson, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import { writePreviewManifest } from '../../lib/preview-manifest.js';
import { overwriteEnvFile } from '../../lib/env-writer.js';
import type { Branch } from '../../types.js';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000;

export function registerPreviewCreateCommand(preview: Command): void {
  preview
    .command('create <name>')
    .description('Create an isolated full-stack preview environment (experimental)')
    .option(
      '--wire-env [file]',
      'Point a frontend env file at the branch backend (default .env.local)',
    )
    .action(async (name: string, opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const project = getProjectConfig();
        if (!project) {
          throw new CLIError('No project linked. Run `insforge link` first.');
        }
        if (project.branched_from) {
          throw new CLIError(
            'This directory is on a branch. Switch to the parent before creating a preview.',
          );
        }

        const created = await createBranchApi(project.project_id, { mode: 'full', name }, apiUrl);
        captureEvent(project.project_id, 'cli_preview_create', { name });
        const ready = await pollUntilReady(created.id, apiUrl);

        const previewUrl = `https://${ready.appkey}.${ready.region}.insforge.app`;

        await writePreviewManifest(process.cwd(), {
          name,
          branchId: ready.id,
          appkey: ready.appkey,
          createdAt: ready.branch_created_at,
        });

        let wiredEnvFile: string | undefined;
        if (opts.wireEnv) {
          const envFile: string = typeof opts.wireEnv === 'string' ? opts.wireEnv : '.env.local';
          wiredEnvFile = envFile;
          const envPath = path.resolve(process.cwd(), envFile);
          // Back up an existing file so teardown can restore it. If the file
          // doesn't exist, `overwriteEnvFile` creates it — record that so
          // teardown deletes our creation instead of looking for a backup.
          const envExisted = existsSync(envPath);
          if (envExisted) {
            copyFileSync(envPath, envPath + '.preview-bak');
          }
          overwriteEnvFile(envPath, { NEXT_PUBLIC_INSFORGE_URL: previewUrl });

          await writePreviewManifest(process.cwd(), {
            name,
            branchId: ready.id,
            appkey: ready.appkey,
            createdAt: ready.branch_created_at,
            wiredEnvFile,
            ...(envExisted ? {} : { wiredEnvCreated: true }),
          });
        }

        if (json) {
          outputJson({ preview: { name, branchId: ready.id, appkey: ready.appkey, url: previewUrl } });
        } else {
          outputInfo(`Preview '${name}' ready.`);
          outputInfo(`  Backend URL: ${previewUrl}`);
          if (wiredEnvFile) {
            outputInfo(
              `  Wired ${wiredEnvFile}: NEXT_PUBLIC_INSFORGE_URL -> branch backend (backup: ${wiredEnvFile}.preview-bak)`,
            );
          }
          if (!wiredEnvFile) {
            outputInfo(`  Point your frontend at this backend (set NEXT_PUBLIC_INSFORGE_URL), then verify.`);
          }
          outputInfo(`  Tear down when done: insforge preview teardown ${name}`);
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}

async function pollUntilReady(branchId: string, apiUrl: string | undefined): Promise<Branch> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const branch = await getBranchApi(branchId, apiUrl);
    if (branch.branch_state === 'ready') return branch;
    if (branch.branch_state === 'deleted' || branch.branch_state === 'conflicted') {
      throw new CLIError(`Preview creation failed (state: ${branch.branch_state})`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new CLIError('Preview creation timed out.');
}
