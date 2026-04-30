import type { Command } from 'commander';
import { configurePaymentWebhook } from '../../lib/api/payments.js';
import { requireAuth } from '../../lib/credentials.js';
import { getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputSuccess, outputTable } from '../../lib/output.js';
import { formatDate, parseEnvironment, trackPaymentUsage } from './utils.js';

export function registerPaymentsWebhooksCommand(paymentsCmd: Command): void {
  const webhooksCmd = paymentsCmd
    .command('webhooks')
    .description('Manage InsForge-managed Stripe webhooks');

  webhooksCmd
    .command('configure <environment>')
    .description('Create or recreate the managed Stripe webhook endpoint')
    .action(async (environmentValue: string, _opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(environmentValue);
        await requireAuth();

        const data = await configurePaymentWebhook(environment);

        if (json) {
          outputJson(data);
        } else {
          outputTable(
            ['Env', 'Webhook ID', 'URL', 'Configured At'],
            [[
              data.connection.environment,
              data.connection.webhookEndpointId ?? '-',
              data.connection.webhookEndpointUrl ?? '-',
              formatDate(data.connection.webhookConfiguredAt),
            ]],
          );
          outputSuccess(`Stripe ${environment} webhook configured.`);
        }

        await trackPaymentUsage('webhooks.configure', true, { environment });
      } catch (err) {
        await trackPaymentUsage('webhooks.configure', false, { environment: environmentValue });
        handleError(err, json);
      }
    });
}
