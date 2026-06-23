import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import {
  getProject,
  updateProject,
  deleteProject,
  restoreProject,
  upgradeInstance,
  restartProjectVersion,
  getLatestInsforgeVersion,
} from '../../lib/api/platform.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectId } from '../../lib/config.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';

/**
 * Resolve which project a lifecycle command targets. Honors --project / the
 * INSFORGE_PROJECT_ID env var / the linked project (in that order). For
 * destructive cross-project ops the caller can require an explicit id.
 */
function resolveProjectId(opts: { project?: string }, requireExplicit = false): string {
  if (requireExplicit && !opts.project && !process.env.INSFORGE_PROJECT_ID) {
    throw new CLIError(
      'Refusing to act on the linked project implicitly. Pass --project <id> to target a project explicitly.',
    );
  }
  const id = getProjectId(opts.project);
  if (!id) {
    throw new CLIError('No project specified. Pass --project <id> or run `insforge link` first.');
  }
  return id;
}

/** Instance classes the CLI offers, smallest → largest. xl is the ceiling. */
const INSTANCE_TYPES = ['nano', 'micro', 'small', 'medium', 'large', 'xl'];

export function registerProjectManageCommands(projectsCmd: Command): void {
  projectsCmd
    .command('get')
    .description('Show a project\'s current status and details')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);
        const project = await getProject(projectId, apiUrl);

        if (json) {
          outputJson(project);
        } else {
          outputInfo(`Name:       ${project.name}`);
          outputInfo(`ID:         ${project.id}`);
          outputInfo(`Status:     ${project.status}${project.operation_status ? ` (${project.operation_status})` : ''}`);
          outputInfo(`Region:     ${project.region}`);
          outputInfo(`Instance:   ${project.instance_type}`);
          outputInfo(`Version:    ${project.service_version ?? 'unknown'}`);
          if (project.customized_domain) outputInfo(`Domain:     ${project.customized_domain}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  projectsCmd
    .command('update')
    .description('Update project settings (rename, custom domain, storage size)')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .option('--name <name>', 'New project name (min 2 characters)')
    .option('--domain <domain>', 'Custom domain')
    .option('--storage-size <gib>', 'Storage disk size in GiB (min 8)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);

        const body: { name?: string; customizedDomain?: string; storageDiskSize?: number } = {};
        if (opts.name) body.name = opts.name;
        if (opts.domain) body.customizedDomain = opts.domain;
        if (opts.storageSize !== undefined) {
          const size = Number(opts.storageSize);
          if (!Number.isInteger(size) || size < 8) {
            throw new CLIError('--storage-size must be an integer >= 8 (GiB).');
          }
          body.storageDiskSize = size;
        }
        if (Object.keys(body).length === 0) {
          throw new CLIError('Nothing to update. Pass --name, --domain, or --storage-size.');
        }

        const project = await updateProject(projectId, body, apiUrl);
        captureEvent(projectId, 'cli_project_update', { fields: Object.keys(body) });

        if (json) {
          outputJson(project);
        } else {
          outputSuccess(`Project "${project.name}" updated.`);
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });

  projectsCmd
    .command('delete')
    .description('Permanently delete a project')
    .option('--project <id>', 'Project ID (required — will not default to the linked project)')
    .action(async (opts, cmd) => {
      const { json, apiUrl, yes } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts, true);

        if (!yes && !json) {
          const project = await getProject(projectId, apiUrl).catch(() => null);
          const label = project ? `"${project.name}" (${projectId})` : projectId;
          const confirmed = await clack.confirm({
            message: `Permanently delete project ${label}? This destroys its database, storage, and all resources.`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }

        await deleteProject(projectId, apiUrl);
        captureEvent(projectId, 'cli_project_delete', {});

        if (json) {
          outputJson({ deleted: true, project_id: projectId });
        } else {
          outputSuccess(`Project ${projectId} deleted.`);
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });

  projectsCmd
    .command('restore')
    .description('Restore a paused project (brings it back online)')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);

        const project = await restoreProject(projectId, apiUrl);
        captureEvent(projectId, 'cli_project_restore', {});

        if (json) {
          outputJson(project);
        } else {
          outputSuccess(`Project "${project.name}" restore initiated (status: ${project.status}).`);
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });

  projectsCmd
    .command('update-version')
    .description('Update the project to the latest InsForge backend version (restarts the instance)')
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .option('--wait', 'Wait for the restart to finish instead of returning while it is queued')
    .action(async (opts, cmd) => {
      const { json, apiUrl, yes } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);

        // Resolve the latest version explicitly — the same contract the
        // dashboard uses. An unpinned restart is NOT a reliable "go to latest"
        // (it keeps whatever tag the instance .env already has), so we always
        // pass the resolved version.
        const latest = await getLatestInsforgeVersion(apiUrl);
        const project = await getProject(projectId, apiUrl).catch(() => null);
        const current = project?.service_version ?? null;

        if (current && current === latest) {
          if (json) {
            outputJson({ updated: false, current_version: current, latest_version: latest });
          } else {
            outputInfo(`Project is already on the latest version (${latest}).`);
          }
          return;
        }

        if (!yes && !json) {
          const from = current ? `from ${current} ` : '';
          const confirmed = await clack.confirm({
            message: `Update the project ${from}to the latest InsForge version (${latest})? There will be a brief downtime.`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }

        const updated = await restartProjectVersion(projectId, latest, !!opts.wait, apiUrl);
        captureEvent(projectId, 'cli_project_update_version', { version: latest, wait: !!opts.wait });

        if (json) {
          outputJson(updated);
        } else if (opts.wait) {
          outputSuccess(`Project "${updated.name}" updated to ${latest}.`);
        } else {
          outputSuccess(`Project "${updated.name}" is updating to ${latest} (queued). Re-run with --wait to block until done.`);
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });

  projectsCmd
    .command('upgrade-instance <instanceType>')
    .description(`Change the project instance type (${INSTANCE_TYPES.join(' | ')})`)
    .option('--project <id>', 'Project ID (defaults to the linked project)')
    .action(async (instanceType: string, opts, cmd) => {
      const { json, apiUrl, yes } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const projectId = resolveProjectId(opts);

        if (!INSTANCE_TYPES.includes(instanceType)) {
          throw new CLIError(
            `Invalid instance type "${instanceType}". Valid types: ${INSTANCE_TYPES.join(', ')}.`,
          );
        }

        if (!yes && !json) {
          const confirmed = await clack.confirm({
            message: `Change the instance type to "${instanceType}"? This restarts the project and may change your bill.`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }

        const result = await upgradeInstance(projectId, { instanceType }, apiUrl);
        captureEvent(projectId, 'cli_project_upgrade_instance', { instanceType });

        if (json) {
          outputJson(result);
        } else {
          outputSuccess(result.message);
          if (result.previousInstanceType !== result.newInstanceType) {
            outputInfo(`Instance: ${result.previousInstanceType} → ${result.newInstanceType}`);
          }
        }
      } catch (err) {
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
