import type { Command } from 'commander';
import { existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as clack from '@clack/prompts';
import { FAKE_PROJECT_ID, getProjectConfig, getProjectConfigFile } from '../../lib/config.js';
import { ensureDockerReady } from '../../lib/docker.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import { composeRunInherit, writeRenderedCompose, type ComposeContext } from '../../lib/local/compose.js';
import { DEFAULT_REF } from '../../lib/local/upstream.js';
import { clearLocalState, localComposeFile, readLocalState } from '../../lib/local/state.js';

interface StopOptions {
  deleteData?: boolean;
  unlink?: boolean;
}

/** Put a cloud link that `local start` displaced back in place. */
function restoreCloudLink(): string | null {
  const backup = join(process.cwd(), '.insforge', 'project.cloud.json');
  if (!existsSync(backup)) return null;
  copyFileSync(backup, getProjectConfigFile());
  unlinkSync(backup);
  return getProjectConfig()?.project_name ?? null;
}

export function registerLocalStopCommand(localCmd: Command): void {
  localCmd
    .command('stop')
    .description('Stop the local InsForge backend for this directory (data is kept)')
    .option('--delete-data', 'Also remove the volumes — database, storage, and logs are destroyed')
    .option('--unlink', 'Restore the cloud project link this directory had before `local start`')
    .action(async (opts: StopOptions, cmd: Command) => {
      const { json } = getRootOpts(cmd);
      try {
        ensureDockerReady();

        const state = readLocalState();
        if (!state) {
          throw new CLIError(
            'No local instance is recorded for this directory.\n' +
              'Run `insforge local start` here first, or `docker ps` to find instances started elsewhere.',
          );
        }

        // Re-render if the file is gone (deleted by hand, or by a previous
        // --delete-data). Every compose call needs it, and without this the only
        // way to stop the containers would be raw `docker`.
        const ref = state.stackTag ?? DEFAULT_REF;
        if (!existsSync(localComposeFile())) writeRenderedCompose(ref);

        const ctx: ComposeContext = { projectName: state.projectName, storage: state.storage, ref };
        const args = opts.deleteData ? ['down', '-v'] : ['down'];
        if (composeRunInherit(ctx, args) !== 0) {
          throw new CLIError('docker compose down failed. See the output above.');
        }

        // Only forget the recorded state when the volumes are gone too. After a
        // plain stop the instance still exists and its keys must survive, or the
        // next start would generate new ones and orphan the app's .env.local.
        if (opts.deleteData) {
          clearLocalState();
        }

        let restored: string | null = null;
        if (opts.unlink) {
          restored = restoreCloudLink();
          if (!restored) {
            const current = getProjectConfig();
            if (current?.project_id === FAKE_PROJECT_ID && existsSync(getProjectConfigFile())) {
              unlinkSync(getProjectConfigFile());
            }
          }
        }

        await trackCommandUsage('local', 'stop', true, { delete_data: !!opts.deleteData });

        if (json) {
          outputJson({
            success: true,
            deletedData: !!opts.deleteData,
            restoredCloudProject: restored,
          });
          return;
        }

        outputSuccess(
          opts.deleteData
            ? 'Local InsForge stopped and all data removed.'
            : 'Local InsForge stopped. Data is kept — `insforge local start` resumes it.',
        );
        if (restored) {
          clack.log.info(`Restored the cloud link to "${restored}".`);
        } else if (opts.unlink) {
          clack.log.info('Removed the local link. No cloud project link was saved for this directory.');
        }
      } catch (err) {
        await trackCommandUsage('local', 'stop', false, {}, err);
        handleError(err, json);
      }
    });
}
