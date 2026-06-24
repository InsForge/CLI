import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { updateMcpConnectionStatus } from '../../lib/api/oss.js';
import { getProjectConfig } from '../../lib/config.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { connectMcpProvider, displayMcpConfigPath, parseMcpProvider } from '../../lib/mcp-config.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { captureEvent, shutdownAnalytics } from '../../lib/analytics.js';

export function registerMcpConnectCommand(program: Command): void {
  program
    .command('connect [provider]')
    .description('Connect an MCP provider to the linked InsForge project')
    .action(async (providerArg: string | undefined, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const project = getProjectConfig();
        if (!project) throw new ProjectNotLinkedError();

        const provider = parseMcpProvider(providerArg ?? 'cursor');
        const result = connectMcpProvider(provider, project);
        await updateMcpConnectionStatus('connected');
        captureEvent(project.project_id, 'cli_mcp_connect', {
          provider,
          project_id: project.project_id,
          project_name: project.project_name,
          org_id: project.org_id,
          region: project.region,
          changed: result.changed,
        });
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
