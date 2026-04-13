import type { Command } from 'commander';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as clack from '@clack/prompts';
import {
  listOrganizations,
  listProjects,
  getProject,
  getProjectApiKey,
  reportAgentConnected,
} from '../../lib/api/platform.js';
import { getGlobalConfig, saveGlobalConfig, saveProjectConfig, getFrontendUrl } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { installSkills, reportCliUsage } from '../../lib/skills.js';
import { captureEvent, trackCommand, shutdownAnalytics } from '../../lib/analytics.js';
import { downloadGitHubTemplate, downloadTemplate, type Framework } from '../create.js';
import type { ProjectConfig } from '../../types.js';

const execAsync = promisify(exec);

function buildOssHost(appkey: string, region: string): string {
  return `https://${appkey}.${region}.insforge.app`;
}

export function registerProjectLinkCommand(program: Command): void {
  program
    .command('link')
    .description('Link current directory to an InsForge project')
    .option('--project-id <id>', 'Project ID to link')
    .option('--org-id <id>', 'Organization ID')
    .option('--template <template>', 'Download a template after linking: react, nextjs, chatbot, crm, e-commerce, todo')
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
            await reportCliUsage('cli.link_direct', true, 6, projectConfig);

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

        // Show organization selection (auto-select if only one)
        if (!orgId && !projectId) {
          const orgs = await listOrganizations(apiUrl);
          if (orgs.length === 0) {
            throw new CLIError('No organizations found.');
          }
          if (orgs.length === 1) {
            orgId = orgs[0].id;
            if (!json) clack.log.info(`Using organization: ${orgs[0].name}`);
          } else {
            if (json) {
              throw new CLIError('Multiple organizations found. Specify --org-id.');
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

        // Save config in cwd only if not using --template (template flow saves in subdirectory)
        if (!opts.template) {
          saveProjectConfig(projectConfig);
        }

        trackCommand('link', project.organization_id);

        if (json) {
          outputJson({ success: true, project: { id: project.id, name: project.name, region: project.region } });
        } else {
          outputSuccess(`Linked to project "${project.name}" (${project.appkey}.${project.region})`);
        }

        // Report agent-connected event (best-effort)
        try {
          await reportAgentConnected({ project_id: project.id }, apiUrl);
        } catch { /* ignore */ }

        // Template download (only when --template flag is passed)
        const template = opts.template as string | undefined;
        if (template) {
          const validTemplates = ['react', 'nextjs', 'chatbot', 'crm', 'e-commerce', 'todo'];
          if (!validTemplates.includes(template)) {
            throw new CLIError(`Invalid template "${template}". Valid options: ${validTemplates.join(', ')}`);
          }

          // Ask for directory name
          let dirName = project.name;
          if (!json) {
            const inputDir = await clack.text({
              message: 'Directory name:',
              initialValue: project.name,
              validate: (v) => {
                if (v.length < 1) return 'Directory name is required';
                const normalized = path.basename(v).replace(/[^a-zA-Z0-9._-]/g, '-');
                if (!normalized || normalized === '.' || normalized === '..') return 'Invalid directory name';
                return undefined;
              },
            });
            if (clack.isCancel(inputDir)) process.exit(0);
            dirName = path.basename(inputDir as string).replace(/[^a-zA-Z0-9._-]/g, '-');
          }

          if (!dirName || dirName === '.' || dirName === '..') {
            throw new CLIError('Invalid directory name.');
          }

          const templateDir = path.resolve(process.cwd(), dirName);
          const dirExists = await fs.stat(templateDir).catch(() => null);
          if (dirExists) {
            throw new CLIError(`Directory "${dirName}" already exists.`);
          }
          await fs.mkdir(templateDir);
          process.chdir(templateDir);

          // Save project config in the new directory
          saveProjectConfig(projectConfig);

          captureEvent(orgId ?? project.organization_id, 'template_selected', { template, source: 'link' });

          // Download template
          const githubTemplates = ['chatbot', 'crm', 'e-commerce', 'nextjs', 'react', 'todo'];
          if (githubTemplates.includes(template)) {
            await downloadGitHubTemplate(template, projectConfig, json);
          } else {
            await downloadTemplate(template as Framework, projectConfig, project.name, json, apiUrl);
          }

          // Only proceed with install/next steps if template actually downloaded
          const templateDownloaded = await fs.stat(path.join(process.cwd(), 'package.json')).catch(() => null);

          if (templateDownloaded && !json) {
            const installSpinner = clack.spinner();
            installSpinner.start('Installing dependencies...');
            try {
              await execAsync('npm install', { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 });
              installSpinner.stop('Dependencies installed');
            } catch (err) {
              installSpinner.stop('Failed to install dependencies');
              clack.log.warn(`npm install failed: ${(err as Error).message}`);
              clack.log.info('Run `npm install` manually to install dependencies.');
            }
          }

          // Install agent skills inside the project directory
          await installSkills(json);
          await reportCliUsage('cli.link', true, 6, projectConfig);

          if (!json) {
            const dashboardUrl = `${getFrontendUrl()}/dashboard/project/${project.id}`;
            clack.log.step(`Dashboard: ${dashboardUrl}`);
            if (templateDownloaded) {
              const steps = [`cd ${dirName}`, 'npm run dev'];
              clack.note(steps.join('\n'), 'Next steps');
              clack.note('Open your coding agent (Claude Code, Codex, Cursor, etc.) to add new features.', 'Keep building');
            } else {
              clack.log.warn('Template download failed. You can retry or set up manually.');
            }
          }
        } else {
          // No template — install agent skills in the current directory
          await installSkills(json);
          await reportCliUsage('cli.link', true, 6, projectConfig);

          if (!json) {
            const dashboardUrl = `${getFrontendUrl()}/dashboard/project/${project.id}`;
            clack.log.step(`Dashboard: ${dashboardUrl}`);

            const prompts = [
              'Build a todo app with Google OAuth sign-in',
              'Build an Instagram clone where users can upload photos, like, and comment',
              'Build an AI chatbot with conversation history',
            ];
            clack.note(
              `Open your coding agent (Claude Code, Codex, Cursor, etc.) and try:\n\n${prompts.map((p) => `• "${p}"`).join('\n')}`,
              'Start building',
            );
          }
        }
      } catch (err) {
        await reportCliUsage('cli.link', false);
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}


