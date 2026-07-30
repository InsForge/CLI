import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { updateMcpConnectionStatus } from '../../lib/api/oss.js';
import { getProjectConfig } from '../../lib/config.js';
import { handleError, getRootOpts, ProjectNotLinkedError, CLIError } from '../../lib/errors.js';
import { MCP_PROVIDERS, disconnectMcpProvider, displayMcpConfigPath, parseMcpProvider } from '../../lib/mcp-config.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';

export function registerMcpDisconnectCommand(program: Command): void {
  program
    .command('disconnect [provider]')
    .description('Disconnect an MCP provider from the linked InsForge project')
    .option('--api-key <apiKey>', 'API key for InsForge MCP')
    .option('--api-base-url <apiBaseUrl>', 'Base URL of the InsForge backend')
    .action(async (providerArg: string | undefined, options: { apiKey?: string; apiBaseUrl?: string }, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const { apiKey, apiBaseUrl } = options;
        let projectId: string | undefined;
        let projectConfig: ReturnType<typeof getProjectConfig> = null;

        if (apiKey || apiBaseUrl) {
          if (!apiKey || !apiBaseUrl) {
            throw new CLIError('Both --api-key and --api-base-url must be provided if not using a linked project.');
          }
        } else {
          projectConfig = getProjectConfig();
          if (!projectConfig) throw new ProjectNotLinkedError();
          projectId = projectConfig.project_id;
        }

        const providers = providerArg ? [parseMcpProvider(providerArg)] : MCP_PROVIDERS;
        const results = providers.map((provider) => disconnectMcpProvider(provider));
        if (apiKey && apiBaseUrl) {
          await updateMcpConnectionStatus('disconnected', { apiKey, apiBaseUrl });
        } else {
          await updateMcpConnectionStatus('disconnected');
        }
        const changed = results.some((result) => result.changed);

        if (projectId && projectConfig) {
          captureEvent(projectConfig.project_id, 'cli_mcp_disconnect', {
            provider: providerArg ? results[0].provider : 'all',
            project_id: projectConfig.project_id,
            project_name: projectConfig.project_name,
            org_id: projectConfig.org_id,
            region: projectConfig.region,
            changed,
          });
        }
        await reportCliUsage('cli.mcp.disconnect', true);

        if (json) {
          outputJson({
            success: true,
            status: 'disconnected',
            provider: providerArg ? results[0].provider : 'all',
            results: results.map((result) => ({
              provider: result.provider,
              config_path: result.path,
              changed: result.changed,
            })),
            changed,
          });
        } else {
          if (providerArg) {
            const result = results[0];
            outputSuccess(`Disconnected ${result.provider} from InsForge MCP in ${displayMcpConfigPath(result.path)}.`);
          } else {
            outputSuccess('Disconnected InsForge MCP from all known local provider configs.');
            const updated = results.filter((result) => result.changed);
            if (updated.length > 0) {
              clack.log.info(`Updated: ${updated.map((result) => displayMcpConfigPath(result.path)).join(', ')}`);
            }
          }
          if (!changed) {
            clack.log.info('No InsForge MCP entries were present; backend status was still marked disconnected.');
          }
        }
      } catch (err) {
        await reportCliUsage('cli.mcp.disconnect', false);
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
