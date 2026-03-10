import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import {
  listOrganizations,
  listProjects,
  getProject,
  getProjectApiKey,
} from '../../lib/api/platform.js';
import { getGlobalConfig, saveGlobalConfig, saveProjectConfig } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { installSkills, promptCliInstall, reportCliUsage } from '../../lib/skills.js';
import type { ProjectConfig } from '../../types.js';

function buildOssHost(appkey: string, region: string): string {
  return `https://${appkey}.${region}.insforge.app`;
}

export function registerProjectLinkCommand(program: Command): void {
  program
    .command('link')
    .description('Link current directory to an InsForge project')
    .option('--project-id <id>', 'Project ID to link')
    .option('--org-id <id>', 'Organization ID')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);

        let orgId = opts.orgId;
        let projectId = opts.projectId;

        // Show organization selection
        if (!orgId && !projectId) {
          const orgs = await listOrganizations(apiUrl);
          if (orgs.length === 0) {
            throw new CLIError('No organizations found.');
          }
          if (json) {
            throw new CLIError('Specify --org-id in JSON mode.');
          }
          const selected = await clack.select({
            message: 'Select an organization:',
            options: orgs.map((o) => ({
              value: o.id,
              label: o.name,
            })),
          });
          if (clack.isCancel(selected)) process.exit(0);
          orgId = selected as string;
        }

        // Save default org
        const config = getGlobalConfig();
        config.default_org_id = orgId;
        saveGlobalConfig(config);

        // Select project if not specified
        if (!projectId) {
          const projects = await listProjects(orgId, apiUrl);
          if (projects.length === 0) {
            throw new CLIError('No projects found in this organization.');
          }
          if (json) {
            throw new CLIError('Specify --project-id in JSON mode.');
          }
          const selected = await clack.select({
            message: 'Select a project to link:',
            options: projects.map((p) => ({
              value: p.id,
              label: `${p.name} (${p.region}, ${p.status})`,
            })),
          });
          if (clack.isCancel(selected)) process.exit(0);
          projectId = selected as string;
        }

        // Fetch project details and API key
        const [project, apiKey] = await Promise.all([
          getProject(projectId, apiUrl),
          getProjectApiKey(projectId, apiUrl),
        ]);

        const projectConfig: ProjectConfig = {
          project_id: project.id,
          project_name: project.name,
          org_id: project.organization_id,
          appkey: project.appkey,
          region: project.region,
          api_key: apiKey,
          oss_host: buildOssHost(project.appkey, project.region),
        };

        saveProjectConfig(projectConfig);

        if (json) {
          outputJson({ success: true, project: { id: project.id, name: project.name, region: project.region } });
        } else {
          outputSuccess(`Linked to project "${project.name}" (${project.appkey}.${project.region})`);
        }

        // Install CLI globally if not already installed
        await promptCliInstall(json);

        // Install InsForge agent skills
        await installSkills(json);
        await reportCliUsage('cli.link', true, 6);
      } catch (err) {
        await reportCliUsage('cli.link', false);
        handleError(err, json);
      }
    });
}


