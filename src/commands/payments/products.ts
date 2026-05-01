import type { Command } from 'commander';
import * as prompts from '../../lib/prompts.js';
import {
  createPaymentProduct,
  deletePaymentProduct,
  getPaymentProduct,
  listPaymentProducts,
  updatePaymentProduct,
} from '../../lib/api/payments.js';
import { requireAuth } from '../../lib/credentials.js';
import { CLIError, getRootOpts, handleError } from '../../lib/errors.js';
import { outputJson, outputSuccess, outputTable } from '../../lib/output.js';
import type {
  CreatePaymentProductRequest,
  StripeProductMirror,
  UpdatePaymentProductRequest,
} from '@insforge/shared-schemas';
import {
  formatAmount,
  formatDate,
  parseBooleanOption,
  parseEnvironment,
  parseMetadataOption,
  trackPaymentUsage,
} from './utils.js';

function nullableString(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === 'null' ? null : value;
}

function outputProductsTable(products: StripeProductMirror[]): void {
  if (products.length === 0) {
    console.log('No Stripe products found.');
    return;
  }

  outputTable(
    ['Env', 'Product ID', 'Name', 'Active', 'Default Price', 'Synced At'],
    products.map((product) => [
      product.environment,
      product.stripeProductId,
      product.name,
      product.active ? 'Yes' : 'No',
      product.defaultPriceId ?? '-',
      formatDate(product.syncedAt),
    ]),
  );
}

export function registerPaymentsProductsCommand(paymentsCmd: Command): void {
  const productsCmd = paymentsCmd
    .command('products')
    .description('Manage Stripe products');

  productsCmd
    .command('list')
    .description('List mirrored Stripe products')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        const data = await listPaymentProducts(environment);

        if (json) {
          outputJson(data);
        } else {
          outputProductsTable(data.products);
        }

        await trackPaymentUsage('products.list', true, { environment });
      } catch (err) {
        await trackPaymentUsage('products.list', false, { environment: opts.environment });
        handleError(err, json);
      }
    });

  productsCmd
    .command('get <productId>')
    .description('Show one Stripe product and its prices')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .action(async (productId: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        const data = await getPaymentProduct(environment, productId);

        if (json) {
          outputJson(data);
        } else {
          outputProductsTable([data.product]);
          if (data.prices.length > 0) {
            console.log('Prices');
            outputTable(
              ['Price ID', 'Amount', 'Type', 'Active', 'Lookup Key'],
              data.prices.map((price) => [
                price.stripePriceId,
                formatAmount(price.unitAmount, price.currency),
                price.type,
                price.active ? 'Yes' : 'No',
                price.lookupKey ?? '-',
              ]),
            );
          }
        }

        await trackPaymentUsage('products.get', true, { environment });
      } catch (err) {
        await trackPaymentUsage('products.get', false, { environment: opts.environment });
        handleError(err, json);
      }
    });

  productsCmd
    .command('create')
    .description('Create a Stripe product')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .requiredOption('--name <name>', 'Product name')
    .option('--description <description>', 'Product description, or "null"')
    .option('--active <bool>', 'Set active status (true/false)')
    .option('--metadata <json>', 'Metadata JSON object with string values')
    .option('--idempotency-key <key>', 'Caller-stable idempotency key')
    .action(async (opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        const request: CreatePaymentProductRequest = {
          environment,
          name: opts.name,
        };
        const description = nullableString(opts.description);
        const active = parseBooleanOption(opts.active, '--active');
        const metadata = parseMetadataOption(opts.metadata);
        if (description !== undefined) request.description = description;
        if (active !== undefined) request.active = active;
        if (metadata !== undefined) request.metadata = metadata;
        if (opts.idempotencyKey !== undefined) request.idempotencyKey = opts.idempotencyKey;

        const data = await createPaymentProduct(request);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Stripe product created: ${data.product.stripeProductId}`);
        }

        await trackPaymentUsage('products.create', true, { environment });
      } catch (err) {
        await trackPaymentUsage('products.create', false, { environment: opts.environment });
        handleError(err, json);
      }
    });

  productsCmd
    .command('update <productId>')
    .description('Update a Stripe product')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .option('--name <name>', 'Product name')
    .option('--description <description>', 'Product description, or "null"')
    .option('--active <bool>', 'Set active status (true/false)')
    .option('--metadata <json>', 'Metadata JSON object with string values')
    .action(async (productId: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        const request: UpdatePaymentProductRequest = { environment };
        const description = nullableString(opts.description);
        const active = parseBooleanOption(opts.active, '--active');
        const metadata = parseMetadataOption(opts.metadata);
        if (opts.name !== undefined) request.name = opts.name;
        if (description !== undefined) request.description = description;
        if (active !== undefined) request.active = active;
        if (metadata !== undefined) request.metadata = metadata;

        if (Object.keys(request).length === 1) {
          throw new CLIError('Provide at least one option to update (--name, --description, --active, --metadata).');
        }

        const data = await updatePaymentProduct(productId, request);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Stripe product updated: ${data.product.stripeProductId}`);
        }

        await trackPaymentUsage('products.update', true, { environment });
      } catch (err) {
        await trackPaymentUsage('products.update', false, { environment: opts.environment });
        handleError(err, json);
      }
    });

  productsCmd
    .command('delete <productId>')
    .description('Delete a Stripe product that has no prices')
    .requiredOption('--environment <environment>', 'Stripe environment: test or live')
    .action(async (productId: string, opts, cmd) => {
      const { json, yes } = getRootOpts(cmd);
      try {
        const environment = parseEnvironment(opts.environment);
        await requireAuth();

        if (json && !yes) {
          throw new CLIError('Use --yes with --json to delete a Stripe product non-interactively.');
        }

        if (!yes) {
          const confirm = await prompts.confirm({
            message: `Delete Stripe ${environment} product "${productId}"?`,
          });
          if (prompts.isCancel(confirm) || !confirm) process.exit(0);
        }

        const data = await deletePaymentProduct(environment, productId);

        if (json) {
          outputJson(data);
        } else {
          outputSuccess(`Stripe product deleted: ${data.stripeProductId}`);
        }

        await trackPaymentUsage('products.delete', true, { environment });
      } catch (err) {
        await trackPaymentUsage('products.delete', false, { environment: opts.environment });
        handleError(err, json);
      }
    });
}
