import type { Command } from 'commander';
import {
  archivePaymentPrice,
  createPaymentPrice,
  getPaymentPrice,
  listPaymentPrices,
  updatePaymentPrice,
} from '../../lib/api/payments.js';
import { requireAuth } from '../../lib/credentials.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputSuccess, outputTable } from '../../lib/output.js';
import type {
  CreatePaymentPriceRequest,
  StripePriceMirror,
  StripePriceRecurringInterval,
  StripePriceTaxBehavior,
  UpdatePaymentPriceRequest,
} from '@insforge/shared-schemas';
import {
  formatAmount,
  formatDate,
  formatRecurring,
  parseBooleanOption,
  parseEnvironment,
  parseIntegerOption,
  parseMetadataOption,
  trackPaymentUsage,
} from './utils.js';

function nullableString(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === 'null' ? null : value;
}

function parseRecurringInterval(value: string | undefined): StripePriceRecurringInterval | undefined {
  if (value === undefined) return undefined;
  if (value === 'day' || value === 'week' || value === 'month' || value === 'year') return value;
  throw new CLIError('--interval must be one of: day, week, month, year.');
}

function parseTaxBehavior(value: string | undefined): StripePriceTaxBehavior | undefined {
  if (value === undefined) return undefined;
  if (value === 'exclusive' || value === 'inclusive' || value === 'unspecified') return value;
  throw new CLIError('--tax-behavior must be one of: exclusive, inclusive, unspecified.');
}

function outputPricesTable(prices: StripePriceMirror[]): void {
  if (prices.length === 0) {
    console.log('No Stripe prices found.');
    return;
  }

  outputTable(
    ['Env', 'Price ID', 'Product ID', 'Amount', 'Type', 'Active', 'Recurring', 'Synced At'],
    prices.map((price) => [
      price.environment,
      price.stripePriceId,
      price.stripeProductId ?? '-',
      formatAmount(price.unitAmount, price.currency),
      price.type,
      price.active ? 'Yes' : 'No',
      formatRecurring(price.recurringInterval, price.recurringIntervalCount),
      formatDate(price.syncedAt),
    ]),
  );
}

export function registerPaymentsPricesCommand(paymentsCmd: Command): void {
  const pricesCmd = paymentsCmd
    .command('prices')
    .description('Manage Stripe prices');

  pricesCmd
    .command('list')
    .description('List mirrored Stripe prices')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .option('--product <productId>', 'Filter by Stripe product id')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        const data = await listPaymentPrices(environment, opts.product);

        if (json) {
          outputJson(data);
        } else {
          outputPricesTable(data.prices);
        }

        await trackPaymentUsage('prices.list', true, { environment });
      } catch (err) {
        await trackPaymentUsage('prices.list', false, { environment: opts.environment });
        handleError(err, json);
      }
    });

  pricesCmd
    .command('get <priceId>')
    .description('Show one Stripe price')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .action(async (priceId: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        const data = await getPaymentPrice(environment, priceId);

        if (json) {
          outputJson(data);
        } else {
          outputPricesTable([data.price]);
        }

        await trackPaymentUsage('prices.get', true, { environment });
      } catch (err) {
        await trackPaymentUsage('prices.get', false, { environment: opts.environment });
        handleError(err, json);
      }
    });

  pricesCmd
    .command('create')
    .description('Create a Stripe one-time or recurring price')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .requiredOption('--product <productId>', 'Stripe product id')
    .requiredOption('--currency <currency>', 'Three-letter currency code, e.g. usd')
    .requiredOption('--unit-amount <amount>', 'Unit amount in the smallest currency unit, e.g. cents')
    .option('--interval <interval>', 'Recurring interval: day, week, month, or year')
    .option('--interval-count <count>', 'Recurring interval count')
    .option('--lookup-key <key>', 'Stripe lookup key, or "null"')
    .option('--active <bool>', 'Set active status (true/false)')
    .option('--tax-behavior <behavior>', 'exclusive, inclusive, or unspecified')
    .option('--metadata <json>', 'Metadata JSON object with string values')
    .option('--idempotency-key <key>', 'Caller-stable idempotency key')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        const interval = parseRecurringInterval(opts.interval);
        const intervalCount = parseIntegerOption(opts.intervalCount, '--interval-count', { min: 1 });
        if (!interval && intervalCount !== undefined) {
          throw new CLIError('Provide --interval when using --interval-count.');
        }

        const request: CreatePaymentPriceRequest = {
          environment,
          stripeProductId: opts.product,
          currency: opts.currency,
          unitAmount: parseIntegerOption(opts.unitAmount, '--unit-amount', { min: 0 }) ?? 0,
        };
        const lookupKey = nullableString(opts.lookupKey);
        const active = parseBooleanOption(opts.active, '--active');
        const taxBehavior = parseTaxBehavior(opts.taxBehavior);
        const metadata = parseMetadataOption(opts.metadata);
        if (lookupKey !== undefined) request.lookupKey = lookupKey;
        if (active !== undefined) request.active = active;
        if (taxBehavior !== undefined) request.taxBehavior = taxBehavior;
        if (metadata !== undefined) request.metadata = metadata;
        if (opts.idempotencyKey !== undefined) request.idempotencyKey = opts.idempotencyKey;
        if (interval) {
          request.recurring = {
            interval,
            ...(intervalCount !== undefined ? { intervalCount } : {}),
          };
        }

        const data = await createPaymentPrice(request);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Stripe price created: ${data.price.stripePriceId}`);
        }

        await trackPaymentUsage('prices.create', true, { environment });
      } catch (err) {
        await trackPaymentUsage('prices.create', false, { environment: opts.environment });
        handleError(err, json);
      }
    });

  pricesCmd
    .command('update <priceId>')
    .description('Update a Stripe price')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .option('--active <bool>', 'Set active status (true/false)')
    .option('--lookup-key <key>', 'Stripe lookup key, or "null"')
    .option('--tax-behavior <behavior>', 'exclusive, inclusive, or unspecified')
    .option('--metadata <json>', 'Metadata JSON object with string values')
    .action(async (priceId: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        const request: UpdatePaymentPriceRequest = { environment };
        const active = parseBooleanOption(opts.active, '--active');
        const lookupKey = nullableString(opts.lookupKey);
        const taxBehavior = parseTaxBehavior(opts.taxBehavior);
        const metadata = parseMetadataOption(opts.metadata);
        if (active !== undefined) request.active = active;
        if (lookupKey !== undefined) request.lookupKey = lookupKey;
        if (taxBehavior !== undefined) request.taxBehavior = taxBehavior;
        if (metadata !== undefined) request.metadata = metadata;

        if (Object.keys(request).length === 1) {
          throw new CLIError('Provide at least one option to update (--active, --lookup-key, --tax-behavior, --metadata).');
        }

        const data = await updatePaymentPrice(priceId, request);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Stripe price updated: ${data.price.stripePriceId}`);
        }

        await trackPaymentUsage('prices.update', true, { environment });
      } catch (err) {
        await trackPaymentUsage('prices.update', false, { environment: opts.environment });
        handleError(err, json);
      }
    });

  pricesCmd
    .command('archive <priceId>')
    .alias('delete')
    .description('Archive a Stripe price')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .action(async (priceId: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        const data = await archivePaymentPrice(environment, priceId);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Stripe price archived: ${data.price.stripePriceId}`);
        }

        await trackPaymentUsage('prices.archive', true, { environment });
      } catch (err) {
        await trackPaymentUsage('prices.archive', false, { environment: opts.environment });
        handleError(err, json);
      }
    });
}
