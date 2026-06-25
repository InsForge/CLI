import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { updateMcpConnectionStatus } from '../../lib/api/oss.js';
import { getProjectConfig } from '../../lib/config.js';
import { handleError, getRootOpts, ProjectNotLinkedError, CLIError } from '../../lib/errors.js';
import { connectMcpProvider, displayMcpConfigPath, parseMcpProvider } from '../../lib/mcp-config.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';
import type { ProjectConfig } from '../../types.js';

export function registerMcpConnectCommand(program: Command): void {
  program
    .command('connect [provider]')
    .description('Connect an MCP provider to the linked InsForge project')
    .option('--api-key <apiKey>', 'API key for InsForge MCP')
    .option('--api-base-url <apiBaseUrl>', 'Base URL of the InsForge backend')
    .action(async (providerArg: string | undefined, options: { apiKey?: string; apiBaseUrl?: string }, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const { apiKey, apiBaseUrl } = options;
        let connectionConfig: { apiKey: string; apiBaseUrl: string } | ProjectConfig;
        let projectId: string | undefined;

        if (apiKey || apiBaseUrl) {
          if (!apiKey || !apiBaseUrl) {
            throw new CLIError('Both --api-key and --api-base-url must be provided if not using a linked project.');
          }
          connectionConfig = { apiKey, apiBaseUrl };
        } else {
          const project = getProjectConfig();
          if (!project) throw new ProjectNotLinkedError();
          connectionConfig = project;
          projectId = project.project_id;
        }

        const provider = parseMcpProvider(providerArg ?? 'cursor');
        const result = connectMcpProvider(provider, connectionConfig);
        if (apiKey && apiBaseUrl) {
          await updateMcpConnectionStatus('connected', { apiKey, apiBaseUrl });
        } else {
          await updateMcpConnectionStatus('connected');
        }

        if (projectId && 'project_id' in connectionConfig) {
          captureEvent(connectionConfig.project_id, 'cli_mcp_connect', {
            provider,
            project_id: connectionConfig.project_id,
            project_name: connectionConfig.project_name,
            org_id: connectionConfig.org_id,
            region: connectionConfig.region,
            changed: result.changed,
          });
        }
        await reportCliUsage('cli.mcp.connect', true);

        if (json) {
          outputJson({
            success: true,
            status: 'connected',
            provider,
            config_path: result.path,
            changed: result.changed,
          });
        } else {
          outputSuccess(`Connected ${provider} to InsForge MCP in ${displayMcpConfigPath(result.path)}.`);
          if (!result.changed) {
            clack.log.info('The existing InsForge MCP entry was already up to date.');
          }
        }
      } catch (err) {
        await reportCliUsage('cli.mcp.connect', false);
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
