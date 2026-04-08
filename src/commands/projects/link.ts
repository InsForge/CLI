import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import {
  listOrganizations,
  listProjects,
  getProject,
  getProjectApiKey,
  reportAgentConnected,
} from '../../lib/api/platform.js';
import { getGlobalConfig, saveGlobalConfig, saveProjectConfig } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { installSkills, reportCliUsage } from '../../lib/skills.js';
import { trackCommand, shutdownAnalytics } from '../../lib/analytics.js';
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
    .option('--api-base-url <url>', 'API Base URL for direct linking (OSS/Self-hosted)')
    .option('--api-key <key>', 'API Key for direct linking (OSS/Self-hosted)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        if (opts.apiBaseUrl || opts.apiKey) {
          try {
            if (!opts.apiBaseUrl || !opts.apiKey) {
              throw new CLIError('Both --api-base-url and --api-key must be provided together for direct linking.');
            }

            try {
              new URL(opts.apiBaseUrl);
            } catch {
              throw new CLIError('Invalid --api-base-url. Please provide a valid URL.');
            }

            // Direct OSS/Self-hosted linking bypasses OAuth
            const projectConfig: ProjectConfig = {
              project_id: 'oss-project',
              project_name: 'oss-project',
              org_id: 'oss-org',
              appkey: 'oss',
              region: 'local',
              api_key: opts.apiKey,
              oss_host: opts.apiBaseUrl.replace(/\/$/, ''), // remove trailing slash if any
            };

            saveProjectConfig(projectConfig);

            if (json) {
              outputJson({ success: true, project: { id: projectConfig.project_id, name: projectConfig.project_name, region: projectConfig.region } });
            } else {
              outputSuccess(`Linked to direct project at ${projectConfig.oss_host}`);
            }

            trackCommand('link', 'oss-org', { direct: true });

            // Install agent skills
            await installSkills(json);
            await reportCliUsage('cli.link_direct', true, 6);

            // Report agent-connected event (best-effort)
            try {
              const urlMatch = opts.apiBaseUrl.match(/^https?:\/\/([^.]+)\.[^.]+\.insforge\.app/);
              if (urlMatch) {
                await reportAgentConnected({ app_key: urlMatch[1] }, apiUrl);
              }
            } catch { /* ignore */ }
            return;
          } catch (err) {
            await reportCliUsage('cli.link_direct', false);
            handleError(err, json);
          }
        }

        const creds = await requireAuth(apiUrl, false);

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
        let project;
        let apiKey;
        try {
          [project, apiKey] = await Promise.all([
            getProject(projectId, apiUrl),
            getProjectApiKey(projectId, apiUrl),
          ]);
        } catch (err) {
          if (err instanceof CLIError && (err.exitCode === 5 || err.exitCode === 4 || err.message.includes('not found'))) {
            const identity = creds.user?.email ?? creds.user?.name ?? 'unknown user';
            throw new CLIError(
              `You're logged in as ${identity}, and you don't have access to project ${projectId}. Check that the project ID is correct and belongs to one of your organizations.`,
              5,
              'PERMISSION_DENIED',
            );
          }
          throw err;
        }

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

        trackCommand('link', project.organization_id);

        if (json) {
          outputJson({ success: true, project: { id: project.id, name: project.name, region: project.region } });
        } else {
          outputSuccess(`Linked to project "${project.name}" (${project.appkey}.${project.region})`);
        }

        // Install agent skills
        await installSkills(json);
        await reportCliUsage('cli.link', true, 6);

        // Report agent-connected event (best-effort)
        try {
          await reportAgentConnected({ project_id: project.id }, apiUrl);
        } catch { /* ignore */ }
      } catch (err) {
        await reportCliUsage('cli.link', false);
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}


