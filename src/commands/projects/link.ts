import type { Command } from 'commander';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as clack from '@clack/prompts';
import pc from 'picocolors';
import * as prompts from '../../lib/prompts.js';
import {
  listOrganizations,
  listProjects,
  getProject,
  getProjectApiKey,
  reportAgentConnected,
} from '../../lib/api/platform.js';
import { getGlobalConfig, saveGlobalConfig, saveProjectConfig, getFrontendUrl, FAKE_PROJECT_ID, FAKE_ORG_ID } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { installSkills, reportCliUsage } from '../../lib/skills.js';
import { applyAuthProvider, getAuthProviderNextSteps, VALID_AUTH_PROVIDERS, type AuthProvider } from '../../auth-providers/apply.js';
import { captureEvent, trackCommand, shutdownAnalytics } from '../../lib/analytics.js';
import { downloadGitHubTemplate } from '../create.js';
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
    .option('--auth <provider>', 'Wire a third-party auth provider into the chosen template (currently: better-auth)')
    .option('--api-base-url <url>', 'API Base URL for direct linking (OSS/Self-hosted)')
    .option('--api-key <key>', 'API Key for direct linking (OSS/Self-hosted)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);

      // Every template value accepted here is a directory in the InsForge
      // templates repo, so validation and the download call reference the
      // same single list.
      const validTemplates = ['react', 'nextjs', 'chatbot', 'crm', 'e-commerce', 'todo'];

      // --auth is a flag-only escape hatch (not in the interactive picker). It
      // composes onto whatever the link/template flow produces by overlaying
      // an auth-provider scaffold from CLI's bundled assets — no templates-repo
      // directory required.
      if (opts.auth && !VALID_AUTH_PROVIDERS.includes(opts.auth)) {
        throw new CLIError(`Invalid --auth "${opts.auth}". Valid: ${VALID_AUTH_PROVIDERS.join(', ')}`);
      }

      try {
        if (opts.template && !validTemplates.includes(opts.template)) {
          throw new CLIError(`Invalid template "${opts.template}". Valid options: ${validTemplates.join(', ')}`);
        }

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
              project_id: FAKE_PROJECT_ID,
              project_name: 'oss-project',
              org_id: FAKE_ORG_ID,
              appkey: 'ossfkey',
              region: 'us-test',
              api_key: opts.apiKey,
              oss_host: opts.apiBaseUrl.replace(/\/$/, ''), // remove trailing slash if any
            };

            const template = opts.template as string | undefined;

            // Template path: create a subdirectory, link inside it, download template,
            // install deps. Mirrors the OAuth template flow below.
            if (template) {
              const defaultDir = `insforge-${template}`;
              let dirName = defaultDir;
              if (!json) {
                const inputDir = await prompts.text({
                  message: 'Directory name:',
                  initialValue: defaultDir,
                  validate: (v) => {
                    if (v.length < 1) return 'Directory name is required';
                    const normalized = path.basename(v).replace(/[^a-zA-Z0-9._-]/g, '-');
                    if (!normalized || normalized === '.' || normalized === '..') return 'Invalid directory name';
                    return undefined;
                  },
                });
                if (prompts.isCancel(inputDir)) process.exit(0);
                dirName = path.basename(inputDir).replace(/[^a-zA-Z0-9._-]/g, '-');
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

              saveProjectConfig(projectConfig);

              if (json) {
                outputJson({
                  success: true,
                  project: { id: projectConfig.project_id, name: projectConfig.project_name, region: projectConfig.region },
                  directory: dirName,
                  template,
                });
              } else {
                outputSuccess(`Linked to direct project at ${projectConfig.oss_host}`);
              }

              captureEvent(FAKE_ORG_ID, 'template_selected', { template, source: 'link_direct' });

              await downloadGitHubTemplate(template, projectConfig, json);

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

              // Overlay --auth scaffold (after template, before user prompt)
              if (opts.auth) {
                try {
                  const result = await applyAuthProvider(opts.auth as AuthProvider, process.cwd(), projectConfig, json);
                  if (!json) clack.log.success(`Wired in ${opts.auth}: ${result.written.length} files written, ${result.skipped.length} skipped`);
                } catch (err) {
                  if (!json) clack.log.warn(`Failed to apply --auth ${opts.auth}: ${(err as Error).message}`);
                }
              }

              await installSkills(json);
              trackCommand('link', 'oss-org', { direct: true, template });
              await reportCliUsage('cli.link_direct', true, 6, projectConfig);

              // Report agent-connected event (best-effort)
              try {
                const urlMatch = opts.apiBaseUrl.match(/^https?:\/\/([^.]+)\.[^.]+\.insforge\.app/);
                if (urlMatch) {
                  await reportAgentConnected({ app_key: urlMatch[1] }, apiUrl);
                }
              } catch { /* ignore */ }

              if (!json) {
                if (templateDownloaded) {
                  const runCommand = `${pc.cyan('cd')} ${pc.green(dirName)} ${pc.dim('&&')} ${pc.cyan('npm run dev')}`;
                  const steps = [
                    `${pc.bold('1.')} ${runCommand}`,
                    `${pc.bold('2.')} Open ${pc.cyan('Claude Code')} or ${pc.cyan('Cursor')} and prompt your agent to add more features`,
                  ];
                  clack.note(steps.join('\n'), "What's next");
                } else {
                  clack.log.warn('Template download failed. You can retry or set up manually.');
                }
              }
              return;
            }

            // Non-template direct-link: save config in cwd and return.
            saveProjectConfig(projectConfig);

            if (json) {
              outputJson({ success: true, project: { id: projectConfig.project_id, name: projectConfig.project_name, region: projectConfig.region } });
            } else {
              outputSuccess(`Linked to direct project at ${projectConfig.oss_host}`);
            }

            // --auth without --template: overlay scaffold straight into cwd.
            // This is the "add Better Auth to my existing project" flow.
            if (opts.auth) {
              try {
                const result = await applyAuthProvider(opts.auth as AuthProvider, process.cwd(), projectConfig, json);
                if (!json) {
                  clack.log.success(`Wired in ${opts.auth}: ${result.written.length} files written, ${result.skipped.length} skipped`);
                  const next = getAuthProviderNextSteps(opts.auth as AuthProvider);
                  clack.note(next, "What's next");
                }
              } catch (err) {
                if (!json) clack.log.warn(`Failed to apply --auth ${opts.auth}: ${(err as Error).message}`);
              }
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
            await shutdownAnalytics();
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
            const selected = await prompts.select<string>({
              message: 'Select an organization:',
              options: orgs.map((o) => ({
                value: o.id,
                label: o.name,
              })),
            });
            if (prompts.isCancel(selected)) process.exit(0);
            orgId = selected;
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
          const selected = await prompts.select<string>({
            message: 'Select a project to link:',
            options: projects.map((p) => ({
              value: p.id,
              label: `${p.name} (${p.region}, ${p.status})`,
            })),
          });
          if (prompts.isCancel(selected)) process.exit(0);
          projectId = selected;
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
              `No access to project ${projectId} as ${identity}. Double-check the project ID, or run \`npx @insforge/cli logout\` to switch accounts.`,
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

        // Template download (only when --template flag is passed).
        // Validation already ran at the top of the action.
        const template = opts.template as string | undefined;
        if (template) {
          // Ask for directory name
          let dirName = project.name;
          if (!json) {
            const inputDir = await prompts.text({
              message: 'Directory name:',
              initialValue: project.name,
              validate: (v) => {
                if (v.length < 1) return 'Directory name is required';
                const normalized = path.basename(v).replace(/[^a-zA-Z0-9._-]/g, '-');
                if (!normalized || normalized === '.' || normalized === '..') return 'Invalid directory name';
                return undefined;
              },
            });
            if (prompts.isCancel(inputDir)) process.exit(0);
            dirName = path.basename(inputDir).replace(/[^a-zA-Z0-9._-]/g, '-');
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

          await downloadGitHubTemplate(template, projectConfig, json);

          // Only proceed with install/next steps if template actually downloaded
          const templateDownloaded = await fs.stat(path.join(process.cwd(), 'package.json')).catch(() => null);

          // Overlay --auth scaffold (after template, before install).
          if (opts.auth) {
            try {
              const result = await applyAuthProvider(opts.auth as AuthProvider, process.cwd(), projectConfig, json);
              if (!json) clack.log.success(`Wired in ${opts.auth}: ${result.written.length} files written, ${result.skipped.length} skipped`);
            } catch (err) {
              if (!json) clack.log.warn(`Failed to apply --auth ${opts.auth}: ${(err as Error).message}`);
            }
          }

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
            clack.log.step(`Dashboard: ${pc.underline(dashboardUrl)}`);
            if (templateDownloaded) {
              const runCommand = `${pc.cyan('cd')} ${pc.green(dirName)} ${pc.dim('&&')} ${pc.cyan('npm run dev')}`;
              const steps = [
                `${pc.bold('1.')} ${runCommand}`,
                `${pc.bold('2.')} Open ${pc.cyan('Claude Code')} or ${pc.cyan('Cursor')} and prompt your agent to add more features`,
              ];
              clack.note(steps.join('\n'), "What's next");
            } else {
              clack.log.warn('Template download failed. You can retry or set up manually.');
            }
          }
        } else {
          // No template path. If --auth was passed, overlay the auth scaffold
          // straight into cwd (the "add Better Auth to my existing project"
          // flow). Otherwise we just save config in cwd and exit.
          if (opts.auth) {
            try {
              const result = await applyAuthProvider(opts.auth as AuthProvider, process.cwd(), projectConfig, json);
              if (!json) {
                clack.log.success(`Wired in ${opts.auth}: ${result.written.length} files written, ${result.skipped.length} skipped`);
                const next = getAuthProviderNextSteps(opts.auth as AuthProvider);
                clack.note(next, "What's next");
              }
            } catch (err) {
              if (!json) clack.log.warn(`Failed to apply --auth ${opts.auth}: ${(err as Error).message}`);
            }
          }

          // No template — install agent skills in the current directory
          await installSkills(json);
          await reportCliUsage('cli.link', true, 6, projectConfig);

          if (!json) {
            const dashboardUrl = `${getFrontendUrl()}/dashboard/project/${project.id}`;
            clack.log.step(`Dashboard: ${dashboardUrl}`);

            const prompts = [
              'Build a todo app with Google OAuth sign-in',
              'Build an Instagram clone where users can upload photos, like, and comment',
              'Build an AI chatbot with conversation history and deploy it to a live URL',
            ];
            clack.note(
              `Open your coding agent (Claude Code, Codex, Cursor, etc.) and try:\n\n${prompts.map((p) => `• "${p}"`).join('\n')}`,
              'Start building',
            );
          }
        }
      } catch (err) {
        await reportCliUsage('cli.link', false);
        await shutdownAnalytics();
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}


