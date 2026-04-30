import type { Command } from 'commander';
import { copyFileSync, existsSync, unlinkSync } from 'node:fs';
import {
  getProjectConfig,
  saveProjectConfig,
  getProjectConfigFile,
  getParentBackupFile,
} from '../../lib/config.js';
import { listBranchesApi, getProjectApiKey } from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';

export interface RunBranchSwitchOptions {
  name?: string;
  toParent?: boolean;
  apiUrl: string | undefined;
  json: boolean;
}

/**
 * Public entry point: lets `branch create` chain into the same context-flip
 * logic without re-parsing through Commander.
 */
export async function runBranchSwitch(input: RunBranchSwitchOptions): Promise<void> {
  await requireAuth(input.apiUrl);
  const current = getProjectConfig();
  if (!current) {
    throw new CLIError('No project linked. Run `insforge link` first.');
  }

  const projectFile = getProjectConfigFile();
  const parentBackup = getParentBackupFile();

  if (input.toParent) {
    if (!existsSync(parentBackup)) {
      throw new CLIError(
        'No parent backup found. Re-link the directory with `insforge link --project-id <parent>`.',
      );
    }
    copyFileSync(parentBackup, projectFile);
    unlinkSync(parentBackup);
    captureEvent(current.project_id, 'cli_branch_switch', { direction: 'to_parent' });
    if (input.json) {
      outputJson({ switched: 'parent' });
    } else {
      outputSuccess('Switched back to parent.');
    }
    return;
  }

  if (!input.name) {
    throw new CLIError('Branch name required (or pass --parent).');
  }

  // Resolve branch by name within the parent's branch list. If we're already on
  // a branch, list siblings of the original parent.
  const parentId = current.branched_from?.project_id ?? current.project_id;
  const branches = await listBranchesApi(parentId, input.apiUrl);
  const target = branches.find(b => b.name === input.name);
  if (!target) {
    throw new CLIError(`Branch '${input.name}' not found.`);
  }
  if (target.branch_state !== 'ready') {
    throw new CLIError(
      `Branch '${input.name}' is in state '${target.branch_state}', cannot switch.`,
    );
  }

  // First time leaving the parent: snapshot the current project.json so
  // `--parent` can restore it. Subsequent branch -> branch switches keep
  // the original parent backup unchanged.
  if (!existsSync(parentBackup)) {
    copyFileSync(projectFile, parentBackup);
  }

  const apiKey = await getProjectApiKey(target.id, input.apiUrl);
  const ossHost = `${target.appkey}.${target.region}.insforge.app`;
  const branched_from = current.branched_from ?? {
    project_id: current.project_id,
    project_name: current.project_name,
  };

  saveProjectConfig({
    project_id: target.id,
    project_name: target.name,
    org_id: target.organization_id,
    appkey: target.appkey,
    region: target.region,
    api_key: apiKey,
    oss_host: ossHost,
    branched_from,
  });

  captureEvent(parentId, 'cli_branch_switch', { direction: 'to_branch' });

  if (input.json) {
    outputJson({ switched: 'branch', branch_id: target.id });
  } else {
    outputSuccess(`Switched to branch '${target.name}'.`);
  }
}

export function registerBranchSwitchCommand(branch: Command): void {
  branch
    .command('switch [name]')
    .description("Switch this directory's context to a branch (or back with --parent)")
    .option('--parent', 'Switch back to the parent project')
    .action(async (name: string | undefined, opts: { parent?: boolean }, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await runBranchSwitch({ name, toParent: opts.parent, apiUrl, json });
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
