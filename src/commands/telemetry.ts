import type { Command } from 'commander';
import { getGlobalConfig, saveGlobalConfig } from '../lib/config.js';
import { CLIError, handleError, getRootOpts } from '../lib/errors.js';
import { outputJson, outputSuccess, outputInfo } from '../lib/output.js';

// This command deliberately emits NO analytics events itself — an opt-out
// flow that phones home undermines the point.

/** Mirrors the env checks in analytics.ts isTelemetryDisabled(). */
function envOverride(): string | null {
  const flag = (value: string | undefined): boolean =>
    value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
  if (flag(process.env.DO_NOT_TRACK)) return 'DO_NOT_TRACK';
  if (flag(process.env.INSFORGE_TELEMETRY_DISABLED)) return 'INSFORGE_TELEMETRY_DISABLED';
  return null;
}

interface TelemetryStatus {
  enabled: boolean;
  /** What decides the current state: an env var name, 'config', or 'default'. */
  source: string;
}

function resolveStatus(): TelemetryStatus {
  const env = envOverride();
  if (env) return { enabled: false, source: env };
  const disabled = getGlobalConfig().telemetry_disabled === true;
  return { enabled: !disabled, source: disabled ? 'config' : 'default' };
}

export function registerTelemetryCommand(program: Command): void {
  const telemetryCmd = program
    .command('telemetry')
    .description(
      'Manage anonymous usage analytics. InsForge collects command usage metadata ' +
      '(never SQL, file contents, credentials, or free text) to improve the CLI. ' +
      'Also honored: DO_NOT_TRACK=1 and INSFORGE_TELEMETRY_DISABLED=1.',
    );

  telemetryCmd
    .command('status')
    .description('Show whether anonymous usage analytics is enabled and why')
    .action((_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const status = resolveStatus();
        if (json) {
          outputJson(status);
        } else {
          outputInfo(`Telemetry is ${status.enabled ? 'enabled' : 'disabled'} (source: ${status.source}).`);
          if (status.enabled) {
            outputInfo('Disable with: npx @insforge/cli telemetry disable');
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  telemetryCmd
    .command('disable')
    .description('Persistently opt out of anonymous usage analytics')
    .action((_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const config = getGlobalConfig();
        config.telemetry_disabled = true;
        saveGlobalConfig(config);
        if (json) {
          outputJson({ enabled: false, source: 'config' });
        } else {
          outputSuccess('Telemetry disabled. No usage analytics will be sent.');
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  telemetryCmd
    .command('enable')
    .description('Re-enable anonymous usage analytics')
    .action((_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const config = getGlobalConfig();
        delete config.telemetry_disabled;
        saveGlobalConfig(config);

        // Config no longer disables it, but an env var still can — say so
        // instead of claiming telemetry is back on when it is not.
        const env = envOverride();
        if (env) {
          throw new CLIError(
            `Config updated, but telemetry stays disabled while ${env} is set in the environment.`,
          );
        }
        if (json) {
          outputJson({ enabled: true, source: 'default' });
        } else {
          outputSuccess('Telemetry enabled.');
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
