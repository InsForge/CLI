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
import { getAnonKey, runRawSql } from '../lib/api/oss.js';
import { getGlobalConfig, saveGlobalConfig, saveProjectConfig, getFrontendUrl } from '../lib/config.js';
import { requireAuth } from '../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../lib/errors.js';
import { outputJson } from '../lib/output.js';
import { readEnvFile } from '../lib/env.js';
import { installSkills, reportCliUsage } from '../lib/skills.js';
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

const INSFORGE_BANNER = [
  '██╗███╗   ██╗███████╗███████╗ ██████╗ ██████╗  ██████╗ ███████╗',
  '██║████╗  ██║██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝',
  '██║██╔██╗ ██║███████╗█████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ',
  '██║██║╚██╗██║╚════██║██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ',
  '██║██║ ╚████║███████║██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗',
  '╚═╝╚═╝  ╚═══╝╚══════╝╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
];

async function animateBanner(): Promise<void> {
  const isTTY = process.stderr.isTTY;
  if (!isTTY || process.env.CI) {
    // Non-interactive: just print static banner
    for (const line of INSFORGE_BANNER) {
      process.stderr.write(`${line}\n`);
    }
    process.stderr.write('\n');
    return;
  }

  const totalLines = INSFORGE_BANNER.length;
  const maxLen = Math.max(...INSFORGE_BANNER.map((l) => l.length));
  const cols = process.stderr.columns ?? 0;

  // Narrow terminal: skip animation to avoid garbled output from line wrapping
  if (cols > 0 && cols < maxLen) {
    for (const line of INSFORGE_BANNER) {
      process.stderr.write(`\x1b[97m${line}\x1b[0m\n`);
    }
    process.stderr.write('\n');
    return;
  }

  // Phase 1: Line-by-line reveal with cursor sweep
  const REVEAL_STEPS = 10;
  const REVEAL_DELAY = 30;
  for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
    const line = INSFORGE_BANNER[lineIdx];
    for (let step = 0; step <= REVEAL_STEPS; step++) {
      const pos = Math.floor((step / REVEAL_STEPS) * line.length);
      let rendered = '';
      for (let i = 0; i < line.length; i++) {
        if (i < pos) {
          rendered += `\x1b[97m${line[i]}\x1b[0m`; // bright white (revealed)
        } else if (i === pos) {
          rendered += `\x1b[1;37m${line[i]}\x1b[0m`; // bold white (cursor)
        } else {
          rendered += `\x1b[90m${line[i]}\x1b[0m`; // dim gray (hidden)
        }
      }
      process.stderr.write(`\r${rendered}`);
      await new Promise((r) => setTimeout(r, REVEAL_DELAY));
    }
    process.stderr.write('\n');
  }

  // Phase 2: Shimmer pass across the full banner
  const SHIMMER_STEPS = 16;
  const SHIMMER_DELAY = 40;
  const SHIMMER_WIDTH = 4;
  for (let step = 0; step < SHIMMER_STEPS; step++) {
    const shimmerPos = Math.floor((step / SHIMMER_STEPS) * (maxLen + SHIMMER_WIDTH));
    // Move cursor up to start of banner
    process.stderr.write(`\x1b[${totalLines}A`);
    for (const line of INSFORGE_BANNER) {
      let rendered = '';
      for (let i = 0; i < line.length; i++) {
        const dist = Math.abs(i - shimmerPos);
        if (dist === 0) {
          rendered += `\x1b[1;97m${line[i]}\x1b[0m`; // bold bright white (shimmer peak)
        } else if (dist <= SHIMMER_WIDTH) {
          rendered += `\x1b[37m${line[i]}\x1b[0m`; // white (shimmer edge)
        } else {
          rendered += `\x1b[90m${line[i]}\x1b[0m`; // dim (base)
        }
      }
      process.stderr.write(`${rendered}\n`);
    }
    await new Promise((r) => setTimeout(r, SHIMMER_DELAY));
  }

  // Final: show banner in steady bright white
  process.stderr.write(`\x1b[${totalLines}A`);
  for (const line of INSFORGE_BANNER) {
    process.stderr.write(`\x1b[97m${line}\x1b[0m\n`);
  }
  process.stderr.write('\n');
}

function getDefaultProjectName(): string {
  const dirName = path.basename(process.cwd());
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return sanitized.length >= 2 ? sanitized : '';
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
    .option('--template <template>', 'Template to use: react, nextjs, chatbot, crm, e-commerce, or empty')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl, false);

        if (!json) {
          await animateBanner();
          clack.intro("Let's build something great");
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

        // 2. Project name (pre-filled from directory name)
        let projectName = opts.name;
        if (!projectName) {
          if (json) throw new CLIError('--name is required in JSON mode.');
          const defaultName = getDefaultProjectName();
          const name = await clack.text({
            message: 'Project name:',
            ...(defaultName ? { defaultValue: defaultName, placeholder: defaultName } : {}),
            validate: (v) => (v.length >= 2 ? undefined : 'Name must be at least 2 characters'),
          });
          if (clack.isCancel(name)) process.exit(0);
          projectName = name as string;
        }

        // Sanitize project name to prevent path traversal
        projectName = path.basename(projectName).replace(/[^a-zA-Z0-9._-]/g, '-');
        if (projectName.length < 2) {
          throw new CLIError('Project name must be at least 2 safe characters (letters, numbers, hyphens).');
        }

        // 3. Select template (two-step: blank vs template, then pick template)
        const validTemplates = ['react', 'nextjs', 'chatbot', 'crm', 'e-commerce', 'empty'];
        let template = opts.template as string | undefined;
        if (template && !validTemplates.includes(template)) {
          throw new CLIError(`Invalid template "${template}". Valid options: ${validTemplates.join(', ')}`);
        }
        if (!template) {
          if (json) {
            template = 'empty';
          } else {
            const approach = await clack.select({
              message: 'How would you like to start?',
              options: [
                { value: 'blank', label: 'Blank project', hint: 'Start from scratch with .env.local ready' },
                { value: 'template', label: 'Start from a template', hint: 'Pre-built starter apps' },
              ],
            });
            if (clack.isCancel(approach)) process.exit(0);

            if (approach === 'blank') {
              template = 'empty';
            } else {
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
              template = selected as string;
            }
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

        // 6. Download template or seed env for blank projects
        const hasTemplate = template !== 'empty';
        const githubTemplates = ['chatbot', 'crm', 'e-commerce'];
        if (githubTemplates.includes(template!)) {
          await downloadGitHubTemplate(template!, projectConfig, json);
        } else if (hasTemplate) {
          await downloadTemplate(template as Framework, projectConfig, projectName, json, apiUrl);
        } else {
          // Blank project: seed .env.local with InsForge credentials (non-fatal)
          try {
            const anonKey = await getAnonKey();
            if (!anonKey) {
              if (!json) clack.log.warn('Could not retrieve anon key. You can add it to .env.local manually.');
            } else {
              const envContent = [
                '# InsForge',
                `NEXT_PUBLIC_INSFORGE_URL=${projectConfig.oss_host}`,
                `NEXT_PUBLIC_INSFORGE_ANON_KEY=${anonKey}`,
                '',
              ].join('\n');
              await fs.writeFile(path.join(process.cwd(), '.env.local'), envContent);
              if (!json) {
                clack.log.success('Created .env.local with your InsForge credentials');
              }
            }
          } catch (err) {
            if (!json) {
              clack.log.warn(`Failed to create .env.local: ${(err as Error).message}`);
            }
          }
        }

        // Install agent skills
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
              // Read env vars from .env.local or .env to pass to deployment
              const envVars = await readEnvFile(process.cwd());
              const startBody: { envVars?: Array<{ key: string; value: string }> } = {};
              if (envVars.length > 0) {
                startBody.envVars = envVars;
              }

              const deploySpinner = clack.spinner();
              const result = await deployProject({
                sourceDir: process.cwd(),
                startBody,
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
    const esc = (s: string) => process.platform === 'win32' ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, "'\\''")}'`;
    const command = `npx --yes create-insforge-app@latest ${esc(targetDir)} --frame ${frame} --base-url ${esc(projectConfig.oss_host)} --anon-key ${esc(anonKey)} --skip-install`;

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

async function downloadGitHubTemplate(
  templateName: string,
  projectConfig: ProjectConfig,
  json: boolean,
): Promise<void> {
  const s = !json ? clack.spinner() : null;
  s?.start(`Downloading ${templateName} template...`);

  const tempDir = path.join(tmpdir(), `insforge-template-${Date.now()}`);

  try {
    await fs.mkdir(tempDir, { recursive: true });

    // Shallow clone the templates repo
    await execAsync(
      'git clone --depth 1 https://github.com/InsForge/insforge-templates.git .',
      { cwd: tempDir, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
    );

    const templateDir = path.join(tempDir, templateName);
    const stat = await fs.stat(templateDir).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`Template "${templateName}" not found in repository`);
    }

    // Copy template files to cwd
    s?.message('Copying template files...');
    const cwd = process.cwd();
    await copyDir(templateDir, cwd);

    // Write .env.local from .env.example with InsForge credentials filled in
    const envExamplePath = path.join(cwd, '.env.example');
    const envExampleExists = await fs.stat(envExamplePath).catch(() => null);
    if (envExampleExists) {
      const anonKey = await getAnonKey();
      const envExample = await fs.readFile(envExamplePath, 'utf-8');
      const envContent = envExample.replace(
        /^([A-Z][A-Z0-9_]*=)(.*)$/gm,
        (_, prefix: string, _value: string) => {
          const key = prefix.slice(0, -1); // remove trailing '='
          if (/INSFORGE.*(URL|BASE_URL)$/.test(key)) return `${prefix}${projectConfig.oss_host}`;
          if (/INSFORGE.*ANON_KEY$/.test(key)) return `${prefix}${anonKey}`;
          if (key === 'NEXT_PUBLIC_APP_URL') return `${prefix}https://${projectConfig.appkey}.insforge.site`;
          return `${prefix}${_value}`;
        },
      );
      await fs.writeFile(path.join(cwd, '.env.local'), envContent);
    }

    s?.stop(`${templateName} template downloaded`);

    // Auto-run database migrations if db_init.sql exists
    const migrationPath = path.join(cwd, 'migrations', 'db_init.sql');
    const migrationExists = await fs.stat(migrationPath).catch(() => null);
    if (migrationExists) {
      const dbSpinner = !json ? clack.spinner() : null;
      dbSpinner?.start('Running database migrations...');
      try {
        const sql = await fs.readFile(migrationPath, 'utf-8');
        await runRawSql(sql, true);
        dbSpinner?.stop('Database migrations applied');
      } catch (err) {
        dbSpinner?.stop('Database migration failed');
        if (!json) {
          clack.log.warn(`Migration failed: ${(err as Error).message}`);
          clack.log.info('You can run the migration manually: insforge db query --unrestricted "$(cat migrations/db_init.sql)"');
        } else {
          throw err;
        }
      }
    }
  } catch (err) {
    s?.stop(`${templateName} template download failed`);
    if (!json) {
      clack.log.warn(`Failed to download ${templateName} template: ${(err as Error).message}`);
      clack.log.info('You can manually clone from: https://github.com/InsForge/insforge-templates');
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

