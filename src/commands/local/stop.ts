import type { Command } from 'commander';
import { existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as clack from '@clack/prompts';
import { FAKE_PROJECT_ID, getProjectConfig, getProjectConfigFile } from '../../lib/config.js';
import { ensureDockerReady } from '../../lib/docker.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { checkoutEnvFile } from '../../lib/local/checkout.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import {
  composeRunInherit,
  forceRemoveProject,
  removeProjectVolumes,
  type ComposeContext,
} from '../../lib/local/compose.js';
import { clearLocalState, readLocalState } from '../../lib/local/state.js';

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

        const ctx: ComposeContext = { projectName: state.projectName, storage: state.storage };
        // Without the env file compose refuses to load at all, so fall back to
        // labels. The volume sweep below runs either way and is what actually
        // removes the data.
        if (existsSync(checkoutEnvFile())) {
          const args = opts.deleteData ? ['down', '-v'] : ['down'];
          if (composeRunInherit(ctx, args) !== 0) {
            throw new CLIError('docker compose down failed. See the output above.');
          }
        } else {
          if (!opts.deleteData) {
            throw new CLIError(
              `${checkoutEnvFile()} is missing, so the stack cannot be stopped cleanly.\n\n` +
                'Restore it from a backup, or run `insforge local stop --delete-data`\n' +
                'to remove the containers and their data outright.',
            );
          }
          clack.log.warn(
            `${checkoutEnvFile()} is gone — removing the containers by label instead.`,
          );
          forceRemoveProject(state.projectName);
        }

        // Sweep whatever `down -v` did not name. A --storage switch leaves the
        // previous backend's volume outside the compose files in play, so it
        // survived a delete that reported having removed everything.
        let sweptVolumes: string[] = [];
        let remainingVolumes: string[] = [];
        let sweepError: string | undefined;
        if (opts.deleteData) {
          const sweep = removeProjectVolumes(state.projectName);
          sweptVolumes = sweep.removed;
          remainingVolumes = sweep.remaining;
          sweepError = sweep.error;
          // The state file is the only record of which project the surviving
          // volumes belong to. Clearing it after a partial delete would leave
          // data on disk with nothing pointing at it.
          if (remainingVolumes.length === 0) clearLocalState();
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
            success: remainingVolumes.length === 0,
            deletedData: !!opts.deleteData,
            sweptVolumes,
            remainingVolumes,
            restoredCloudProject: restored,
          });
          return;
        }

        if (remainingVolumes.length > 0) {
          throw new CLIError(
            `The containers are stopped, but ${remainingVolumes.length} volume` +
              `${remainingVolumes.length === 1 ? '' : 's'} could not be removed:\n` +
              remainingVolumes.map((v) => `  • ${v}`).join('\n') +
              (sweepError ? `\n\n${sweepError}` : '') +
              '\n\nThis directory still points at them, so `insforge local stop --delete-data`\n' +
              'will try again once whatever is holding them is gone.',
          );
        }

        outputSuccess(
          opts.deleteData
            ? 'Local InsForge stopped and all data removed.' +
                (sweptVolumes.length > 0
                  ? `
  Also swept ${sweptVolumes.length} volume${sweptVolumes.length === 1 ? '' : 's'} that \`compose down -v\` did not remove.`
                  : '')
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
