import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import { rotateApiKey, rotateAnonKey } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess, outputInfo } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

const KEYS = ['api-key', 'anon-key'];

export function registerSecretsRotateCommand(secretsCmd: Command): void {
  secretsCmd
    .command('rotate <key>')
    .description(`Rotate a project key (${KEYS.join(' | ')})`)
    .option('--grace-hours <n>', 'Hours the old key stays valid (server default applies if omitted)')
    .action(async (key: string, opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        if (!KEYS.includes(key)) {
          throw new CLIError(`Invalid key "${key}". Valid keys: ${KEYS.join(', ')}.`);
        }
        await requireAuth();

        let graceHours: number | undefined;
        if (opts.graceHours !== undefined) {
          graceHours = Number(opts.graceHours);
          if (!Number.isInteger(graceHours) || graceHours < 0) {
            throw new CLIError('--grace-hours must be a non-negative integer.');
          }
        }

        if (!yes && !json) {
          const confirmed = await clack.confirm({
            message: `Rotate the ${key}? The current key keeps working only during the grace period.`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }

        const result = key === 'api-key'
          ? await rotateApiKey(graceHours)
          : await rotateAnonKey(graceHours);
        const newKey = result.apiKey ?? result.anonKey ?? '';

        if (json) {
          outputJson(result);
        } else {
          outputSuccess(result.message);
          outputInfo(`\nNew ${key} (shown once — store it now):\n${newKey}`);
          outputInfo(`\nOld key stops working at: ${new Date(result.oldKeyExpiresAt).toLocaleString()}`);
        }
        await reportCliUsage('cli.secrets.rotate', true);
      } catch (err) {
        await reportCliUsage('cli.secrets.rotate', false);
        handleError(err, json);
      }
    });
}
