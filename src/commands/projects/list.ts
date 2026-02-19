import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { listOrganizations, listProjects } from '../../lib/api/platform.js';
import { getGlobalConfig } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputTable } from '../../lib/output.js';

export function registerProjectsCommands(projectsCmd: Command): void {
  projectsCmd
    .command('list')
    .description('List all projects in an organization')
    .option('--org-id <id>', 'Organization ID (uses default if not specified)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        requireAuth();

        let orgId = opts.orgId ?? getGlobalConfig().default_org_id;

        if (!orgId) {
          // Try to auto-select if user has only one org
          const orgs = await listOrganizations(apiUrl);
          if (orgs.length === 0) {
            throw new CLIError('No organizations found. Create one on the InsForge dashboard.');
          }
          if (orgs.length === 1) {
            orgId = orgs[0].id;
          } else if (!json) {
            const selected = await clack.select({
              message: 'Select an organization:',
              options: orgs.map((o) => ({
                value: o.id,
                label: o.name,
              })),
            });
            if (clack.isCancel(selected)) {
              process.exit(0);
            }
            orgId = selected as string;
          } else {
            throw new CLIError('Multiple organizations found. Specify --org-id.');
          }
        }

        const projects = await listProjects(orgId, apiUrl);

        if (json) {
          outputJson(projects);
        } else {
          if (!projects.length) {
            console.log('No projects found.');
            return;
          }
          outputTable(
            ['ID', 'Name', 'Region', 'Status', 'AppKey'],
            projects.map((p) => [p.id, p.name, p.region, p.status, p.appkey]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
