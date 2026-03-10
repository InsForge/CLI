import type { Command } from 'commander';
import { exec } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as clack from '@clack/prompts';
import {
  listOrganizations,
  createProject,
  getProject,
  getProjectApiKey,
} from '../lib/api/platform.js';
import { getAnonKey } from '../lib/api/oss.js';
import { getGlobalConfig, saveGlobalConfig, saveProjectConfig, getFrontendUrl } from '../lib/config.js';
import { requireAuth } from '../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../lib/errors.js';
import { outputJson } from '../lib/output.js';
import { installCliGlobally, installSkills, reportCliUsage } from '../lib/skills.js';
import { deployProject } from './deployments/deploy.js';
import type { ProjectConfig } from '../types.js';

const execAsync = promisify(exec);

type Framework = 'react' | 'nextjs';

function buildOssHost(appkey: string, region: string): string {
  return `https://${appkey}.${region}.insforge.app`;
}

async function waitForProjectActive(projectId: string, apiUrl?: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const project = await getProject(projectId, apiUrl);
    if (project.status === 'active') return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new CLIError('Project creation timed out. Check the dashboard for status.');
}

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export function registerCreateCommand(program: Command): void {
  program
    .command('create')
    .description('Create a new InsForge project')
    .option('--name <name>', 'Project name')
    .option('--org-id <id>', 'Organization ID')
    .option('--region <region>', 'Deployment region (us-east, us-west, eu-central, ap-southeast)')
    .option('--template <template>', 'Template to use: react, nextjs, or empty')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);

        if (!json) {
          clack.intro('Create a new InsForge project');
        }

        // 1. Select organization
        let orgId = opts.orgId;
        if (!orgId) {
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
        const globalConfig = getGlobalConfig();
        globalConfig.default_org_id = orgId;
        saveGlobalConfig(globalConfig);

        // 2. Project name
        let projectName = opts.name;
        if (!projectName) {
          if (json) throw new CLIError('--name is required in JSON mode.');
          const name = await clack.text({
            message: 'Project name:',
            validate: (v) => (v.length >= 2 ? undefined : 'Name must be at least 2 characters'),
          });
          if (clack.isCancel(name)) process.exit(0);
          projectName = name as string;
        }

        // 3. Select template
        let template = opts.template as string | undefined;
        if (!template) {
          if (json) {
            template = 'empty';
          } else {
            const selected = await clack.select({
              message: 'Choose a starter template:',
              options: [
                { value: 'react', label: 'Web app template with React' },
                { value: 'nextjs', label: 'Web app template with Next.js' },
                { value: 'empty', label: 'Empty project' },
              ],
            });
            if (clack.isCancel(selected)) process.exit(0);
            template = selected as string;
          }
        }

        // 4. Create project via Platform API
        const s = !json ? clack.spinner() : null;
        s?.start('Creating project...');

        const project = await createProject(orgId, projectName, opts.region, apiUrl);

        s?.message('Waiting for project to become active...');
        await waitForProjectActive(project.id, apiUrl);

        // 5. Fetch API key and link project
        const apiKey = await getProjectApiKey(project.id, apiUrl);
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

        s?.stop(`Project "${project.name}" created and linked`);

        // 6. Download template if selected
        const hasTemplate = template !== 'empty';
        if (hasTemplate) {
          await downloadTemplate(template as Framework, projectConfig, projectName, json, apiUrl);
        }

        // Install CLI globally and agent skills
        await installCliGlobally(json);
        await installSkills(json);
        await reportCliUsage('cli.create', true, 6);

        // 7. Install npm dependencies (template projects only)
        if (hasTemplate) {
          const installSpinner = !json ? clack.spinner() : null;
          installSpinner?.start('Installing dependencies...');
          try {
            await execAsync('npm install', { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 });
            installSpinner?.stop('Dependencies installed');
          } catch (err) {
            installSpinner?.stop('Failed to install dependencies');
            if (!json) {
              clack.log.warn(`npm install failed: ${(err as Error).message}`);
              clack.log.info('Run `npm install` manually to install dependencies.');
            }
          }
        }

        // 8. Offer to deploy (template projects, interactive mode only)
        let liveUrl: string | null = null;
        if (hasTemplate && !json) {
          const shouldDeploy = await clack.confirm({
            message: 'Would you like to deploy now?',
          });

          if (!clack.isCancel(shouldDeploy) && shouldDeploy) {
            try {
              const deploySpinner = clack.spinner();
              const result = await deployProject({
                sourceDir: process.cwd(),
                spinner: deploySpinner,
              });

              if (result.isReady) {
                deploySpinner.stop('Deployment complete');
                liveUrl = result.liveUrl;
              } else {
                deploySpinner.stop('Deployment is still building');
                clack.log.info(`Deployment ID: ${result.deploymentId}`);
                clack.log.warn('Deployment did not finish within 2 minutes.');
                clack.log.info(`Check status with: insforge deployments status ${result.deploymentId}`);
              }
            } catch (err) {
              clack.log.warn(`Deploy failed: ${(err as Error).message}`);
            }
          }
        }

        // 9. Show links
        const dashboardUrl = `${getFrontendUrl()}/dashboard/project/${project.id}`;

        if (json) {
          outputJson({
            success: true,
            project: { id: project.id, name: project.name, appkey: project.appkey, region: project.region },
            template,
            urls: {
              dashboard: dashboardUrl,
              ...(liveUrl ? { liveSite: liveUrl } : {}),
            },
          });
        } else {
          clack.log.step(`Dashboard: ${dashboardUrl}`);
          if (liveUrl) {
            clack.log.success(`Live site: ${liveUrl}`);
          }
          clack.outro('Done!');
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}

async function downloadTemplate(
  framework: Framework,
  projectConfig: ProjectConfig,
  projectName: string,
  json: boolean,
  _apiUrl?: string,
): Promise<void> {
  const s = !json ? clack.spinner() : null;
  s?.start('Downloading template...');

  try {
    // Get the anon key from the OSS backend
    const anonKey = await getAnonKey();
    if (!anonKey) {
      throw new Error('Failed to retrieve anon key from backend');
    }

    // Create temp directory for download
    const tempDir = tmpdir();
    const targetDir = projectName;
    const templatePath = path.join(tempDir, targetDir);

    // Remove existing temp directory if it exists
    try {
      await fs.rm(templatePath, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, which is fine
    }

    const frame = framework === 'nextjs' ? 'nextjs' : 'react';
    const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const command = `npx create-insforge-app ${esc(targetDir)} --frame ${frame} --base-url ${esc(projectConfig.oss_host)} --anon-key ${esc(anonKey)} --skip-install`;

    s?.message(`Running create-insforge-app (${frame})...`);

    await execAsync(command, {
      maxBuffer: 10 * 1024 * 1024,
      cwd: tempDir,
    });

    // Copy template files to current directory
    s?.message('Copying template files...');
    const cwd = process.cwd();
    await copyDir(templatePath, cwd);

    // Cleanup temp directory
    await fs.rm(templatePath, { recursive: true, force: true }).catch(() => {});

    s?.stop('Template files downloaded');
  } catch (err) {
    s?.stop('Template download failed');
    if (!json) {
      clack.log.warn(`Failed to download template: ${(err as Error).message}`);
      clack.log.info('You can manually set up the template later.');
    }
  }
}


