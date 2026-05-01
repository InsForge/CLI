import type { Command } from 'commander';
import * as prompts from '../../lib/prompts.js';
import {
  getPaymentsConfig,
  removeStripeSecretKey,
  setStripeSecretKey,
} from '../../lib/api/payments.js';
import { requireAuth } from '../../lib/credentials.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputSuccess, outputTable } from '../../lib/output.js';
import { parseEnvironment, trackPaymentUsage } from './utils.js';

function outputConfigTable(data: Awaited<ReturnType<typeof getPaymentsConfig>>): void {
  if (data.keys.length === 0) {
    console.log('No Stripe keys configured.');
    return;
  }

  outputTable(
    ['Env', 'Configured', 'Key'],
    data.keys.map((key) => [
      key.environment,
      key.hasKey ? 'Yes' : 'No',
      key.maskedKey ?? '-',
    ]),
  );
}

export function registerPaymentsConfigCommand(paymentsCmd: Command): void {
  const configCmd = paymentsCmd
    .command('config')
    .description('Manage Stripe API keys for payments')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const data = await getPaymentsConfig();

        if (json) {
          outputJson(data);
        } else {
          outputConfigTable(data);
        }

        await trackPaymentUsage('config', true);
      } catch (err) {
        await trackPaymentUsage('config', false);
        handleError(err, json);
      }
    });

  configCmd
    .command('set <environment> [secretKey]')
    .description('Configure a Stripe secret key for test or live payments')
    .action(async (environmentValue: string, secretKeyValue: string | undefined, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(environmentValue);
        await requireAuth();

        let secretKey = secretKeyValue;
        if (!secretKey) {
          if (json) {
            throw new CLIError('Provide secretKey when using --json.');
          }

          const input = await prompts.password({
            message: `Stripe ${environment} secret key`,
          });
          if (prompts.isCancel(input)) process.exit(0);
          secretKey = input;
        }

        const data = await setStripeSecretKey(environment, secretKey);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Stripe ${environment} key configured.`);
        }

        await trackPaymentUsage('config.set', true, { environment });
      } catch (err) {
        await trackPaymentUsage('config.set', false, { environment: environmentValue });
        handleError(err, json);
      }
    });

  configCmd
    .command('remove <environment>')
    .alias('delete')
    .description('Remove a configured Stripe secret key')
    .action(async (environmentValue: string, _opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(environmentValue);
        await requireAuth();

        if (json && !yes) {
          throw new CLIError('Use --yes with --json to remove a Stripe key non-interactively.');
        }

        if (!yes) {
          const confirm = await prompts.confirm({
            message: `Remove Stripe ${environment} key? Payment sync and mutations for this environment will stop.`,
          });
          if (prompts.isCancel(confirm) || !confirm) process.exit(0);
        }

        const data = await removeStripeSecretKey(environment);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Stripe ${environment} key removed.`);
        }

        await trackPaymentUsage('config.remove', true, { environment });
      } catch (err) {
        await trackPaymentUsage('config.remove', false, { environment: environmentValue });
        handleError(err, json);
      }
    });
}
