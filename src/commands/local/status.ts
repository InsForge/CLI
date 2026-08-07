import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import pc from 'picocolors';
import { probeBackendHealth } from '../../lib/api/oss.js';
import { ensureDockerReady } from '../../lib/docker.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { outputInfo, outputJson, outputTable } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import { composePs, writeRenderedCompose, type ComposeContext } from '../../lib/local/compose.js';
import { DEFAULT_REF } from '../../lib/local/upstream.js';
import { readSecrets } from '../../lib/local/secrets.js';
import { localComposeFile, readLocalState } from '../../lib/local/state.js';

export function registerLocalStatusCommand(localCmd: Command): void {
  localCmd
    .command('status')
    .description('Show the local InsForge instance for this directory: ports, keys, container health')
    .option('--show-keys', 'Print the API key and admin password in full')
    .action(async (opts: { showKeys?: boolean }, cmd: Command) => {
      const { json } = getRootOpts(cmd);
      try {
        ensureDockerReady();

        const state = readLocalState();
        if (!state) {
          throw new CLIError(
            'No local instance is recorded for this directory.\nRun `insforge local start` to create one.',
          );
        }

        // Re-render if the file is gone (deleted by hand, or by a previous
        // --delete-data). Every compose call needs it, and without this the only
        // way to stop the containers would be raw `docker`.
        const ref = state.stackTag ?? DEFAULT_REF;
        if (!existsSync(localComposeFile())) writeRenderedCompose(ref);

        const ctx: ComposeContext = { projectName: state.projectName, storage: state.storage, ref };
        const services = composePs(ctx);
        const baseUrl = `http://localhost:${state.ports.app}`;
        const health = await probeBackendHealth(baseUrl, 3_000);
        const secrets = readSecrets();

        await trackCommandUsage('local', 'status', true, { healthy: health.reachable });

        if (json) {
          outputJson({
            running: services.some((s) => s.state === 'running'),
            healthy: health.reachable,
            apiUrl: baseUrl,
            databaseUrl: `postgresql://postgres:postgres@localhost:${state.ports.postgres}/insforge`,
            ports: state.ports,
            storage: state.storage,
            stackTag: state.stackTag,
            composeProject: state.projectName,
            createdAt: state.createdAt,
            services,
            // Keys are secrets: only in the payload when explicitly asked for,
            // so `local status --json` is safe to paste into an issue.
            ...(opts.showKeys && secrets
              ? {
                  apiKey: secrets.apiKey,
                  anonKey: secrets.anonKey,
                  admin: { username: secrets.adminUsername, password: secrets.adminPassword },
                }
              : {}),
          });
          return;
        }

        const mask = (v: string): string =>
          opts.showKeys ? v : `${v.slice(0, Math.min(8, v.length))}${'•'.repeat(8)}`;

        outputInfo('');
        outputInfo(
          `  ${health.reachable ? pc.green('● healthy') : pc.yellow('○ not responding')}  ` +
            `${pc.dim('InsForge')} ${state.stackTag ?? 'latest published'}`,
        );
        outputInfo('');
        outputInfo(`  ${pc.dim('API URL   ')} ${pc.cyan(baseUrl)}`);
        outputInfo(
          `  ${pc.dim('DB URL    ')} postgresql://postgres:postgres@localhost:${state.ports.postgres}/insforge`,
        );
        if (secrets) {
          outputInfo(`  ${pc.dim('API key   ')} ${mask(secrets.apiKey)}`);
          outputInfo(`  ${pc.dim('anon key  ')} ${mask(secrets.anonKey)}`);
          outputInfo(
            `  ${pc.dim('Admin     ')} ${secrets.adminUsername} / ${mask(secrets.adminPassword)}`,
          );
        }
        outputInfo(
          `  ${pc.dim('Storage   ')} ${state.storage === 'local' ? 'local filesystem' : state.storage}`,
        );
        outputInfo(`  ${pc.dim('Compose   ')} ${state.projectName}`);
        outputInfo('');

        if (services.length === 0) {
          outputInfo('  No containers. Run `insforge local start` to bring the instance up.');
        } else {
          outputTable(
            ['SERVICE', 'STATE', 'STATUS'],
            services.map((s) => [s.service, s.state, s.health || s.status]),
          );
        }

        if (!opts.showKeys && secrets) {
          outputInfo('');
          outputInfo(pc.dim('  Keys are masked. Re-run with --show-keys to print them in full.'));
        }
      } catch (err) {
        await trackCommandUsage('local', 'status', false, {}, err);
        handleError(err, json);
      }
    });
}
