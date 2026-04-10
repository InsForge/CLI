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
import { getAnonKey } from '../../lib/api/oss.js';
import { getGlobalConfig, saveGlobalConfig, saveProjectConfig, getFrontendUrl } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { readEnvFile } from '../../lib/env.js';
import { installSkills, reportCliUsage } from '../../lib/skills.js';
import { captureEvent, trackCommand, shutdownAnalytics } from '../../lib/analytics.js';
import { deployProject } from '../deployments/deploy.js';
import { downloadGitHubTemplate, downloadTemplate, type Framework } from '../create.js';
import type { ProjectConfig } from '../../types.js';

const execAsync = promisify(exec);

/** Files that indicate real project content exists */
const PROJECT_MARKERS = new Set([
  'package.json',
  'index.html',
  'tsconfig.json',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'vite.config.ts',
  'vite.config.js',
  'src',
  'app',
  'pages',
  'public',
]);

async function isDirEmpty(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir);
  return !entries.some((e) => PROJECT_MARKERS.has(e));
}

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

        // Smart template & deploy prompts (interactive mode only)
        if (!json) {
          const cwd = process.cwd();
          let templateApplied = false;

          // Template prompt: offer if directory is empty
          if (await isDirEmpty(cwd)) {
            const approach = await clack.select({
              message: 'How would you like to start?',
              options: [
                { value: 'blank', label: 'Blank project', hint: 'Start from scratch with .env.local ready' },
                { value: 'template', label: 'Start from a template', hint: 'Pre-built starter apps' },
              ],
            });
            if (clack.isCancel(approach)) process.exit(0);

            captureEvent(orgId ?? project.organization_id, 'link_approach_selected', { approach: approach as string });

            if (approach === 'template') {
              const selected = await clack.select({
                message: 'Choose a starter template:',
                options: [
                  { value: 'react', label: 'Web app template with React' },
                  { value: 'nextjs', label: 'Web app template with Next.js' },
                  { value: 'chatbot', label: 'AI Chatbot with Next.js' },
                  { value: 'crm', label: 'CRM with Next.js' },
                  { value: 'e-commerce', label: 'E-Commerce store with Next.js' },
                ],
              });
              if (clack.isCancel(selected)) process.exit(0);
              const template = selected as string;

              captureEvent(orgId ?? project.organization_id, 'template_selected', { template, source: 'link' });

              // Download template
              const githubTemplates = ['chatbot', 'crm', 'e-commerce', 'nextjs', 'react'];
              if (githubTemplates.includes(template)) {
                await downloadGitHubTemplate(template, projectConfig, json);
              } else {
                await downloadTemplate(template as Framework, projectConfig, project.name, json, apiUrl);
              }

              // Only mark as applied if files were actually downloaded
              templateApplied = !(await isDirEmpty(cwd));

              // Install npm dependencies
              const installSpinner = clack.spinner();
              installSpinner.start('Installing dependencies...');
              try {
                await execAsync('npm install', { cwd, maxBuffer: 10 * 1024 * 1024 });
                installSpinner.stop('Dependencies installed');
              } catch (err) {
                installSpinner.stop('Failed to install dependencies');
                clack.log.warn(`npm install failed: ${(err as Error).message}`);
                clack.log.info('Run `npm install` manually to install dependencies.');
              }
            } else {
              // Blank project: seed .env.local
              try {
                const anonKey = await getAnonKey();
                if (!anonKey) {
                  clack.log.warn('Could not retrieve anon key. You can add it to .env.local manually.');
                } else {
                  const envPath = path.join(cwd, '.env.local');
                  const envContent = [
                    '# InsForge',
                    `NEXT_PUBLIC_INSFORGE_URL=${projectConfig.oss_host}`,
                    `NEXT_PUBLIC_INSFORGE_ANON_KEY=${anonKey}`,
                    '',
                  ].join('\n');
                  await fs.writeFile(envPath, envContent, { flag: 'wx' });
                  clack.log.success('Created .env.local with your InsForge credentials');
                }
              } catch (err) {
                const error = err as NodeJS.ErrnoException;
                if (error.code === 'EEXIST') {
                  clack.log.warn('.env.local already exists; skipping InsForge key seeding.');
                } else {
                  clack.log.warn(`Failed to create .env.local: ${error.message}`);
                }
              }
            }
          }

          // Deploy prompt: only offer when a template was applied
          if (templateApplied) {
            const shouldDeploy = await clack.confirm({
              message: 'Would you like to deploy now?',
            });

            if (!clack.isCancel(shouldDeploy) && shouldDeploy) {
              try {
                const envVars = await readEnvFile(cwd);
                const startBody: { envVars?: Array<{ key: string; value: string }> } = {};
                if (envVars.length > 0) {
                  startBody.envVars = envVars;
                }

                const deploySpinner = clack.spinner();
                const result = await deployProject({
                  sourceDir: cwd,
                  startBody,
                  spinner: deploySpinner,
                });

                if (result.isReady) {
                  deploySpinner.stop('Deployment complete');
                  const liveUrl = result.liveUrl;
                  if (liveUrl) {
                    clack.log.success(`Live site: ${liveUrl}`);
                  }
                } else {
                  deploySpinner.stop('Deployment is still building');
                  clack.log.info(`Deployment ID: ${result.deploymentId}`);
                  clack.log.warn('Deployment did not finish within 5 minutes.');
                  clack.log.info(`Check status with: npx @insforge/cli deployments status ${result.deploymentId}`);
                }
              } catch (err) {
                clack.log.warn(`Deploy failed: ${(err as Error).message}`);
              }
            }
          }

          // Show dashboard link
          const dashboardUrl = `${getFrontendUrl()}/dashboard/project/${project.id}`;
          clack.log.step(`Dashboard: ${dashboardUrl}`);
        }
      } catch (err) {
        await reportCliUsage('cli.link', false);
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}


