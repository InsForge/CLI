import { ossFetch } from './oss.js';
import type {
  ArchivePaymentPriceResponse,
  ConfigurePaymentWebhookResponse,
  CreatePaymentPriceRequest,
  CreatePaymentProductRequest,
  DeletePaymentProductResponse,
  GetPaymentPriceResponse,
  GetPaymentProductResponse,
  GetPaymentsConfigResponse,
  GetPaymentsStatusResponse,
  ListPaymentCatalogResponse,
  ListPaymentHistoryRequest,
  ListPaymentHistoryResponse,
  ListPaymentPricesResponse,
  ListPaymentProductsResponse,
  ListSubscriptionsRequest,
  ListSubscriptionsResponse,
  MutatePaymentPriceResponse,
  MutatePaymentProductResponse,
  StripeEnvironment,
  SyncPaymentsRequest,
  SyncPaymentsResponse,
  UpdatePaymentPriceRequest,
  UpdatePaymentProductRequest,
} from '@insforge/shared-schemas';

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function readJson<T>(res: Response): Promise<T> {
  return await res.json() as T;
}

export async function getPaymentsStatus(): Promise<GetPaymentsStatusResponse> {
  return readJson(await ossFetch('/api/payments/status'));
}

export async function getPaymentsConfig(): Promise<GetPaymentsConfigResponse> {
  return readJson(await ossFetch('/api/payments/config'));
}

export async function setStripeSecretKey(
  environment: StripeEnvironment,
  secretKey: string,
): Promise<GetPaymentsConfigResponse> {
  return readJson(await ossFetch('/api/payments/config', {
    method: 'POST',
    body: JSON.stringify({ environment, secretKey }),
  }));
}

export async function removeStripeSecretKey(
  environment: StripeEnvironment,
): Promise<GetPaymentsConfigResponse> {
  return readJson(await ossFetch(`/api/payments/config/${encodeURIComponent(environment)}`, {
    method: 'DELETE',
  }));
}

export async function syncPayments(environment: SyncPaymentsRequest['environment'] = 'all'): Promise<SyncPaymentsResponse> {
  return readJson(await ossFetch('/api/payments/sync', {
    method: 'POST',
    body: JSON.stringify({ environment }),
  }));
}

export async function configurePaymentWebhook(
  environment: StripeEnvironment,
): Promise<ConfigurePaymentWebhookResponse> {
  return readJson(await ossFetch(
    `/api/payments/webhooks/${encodeURIComponent(environment)}/configure`,
    { method: 'POST' },
  ));
}

export async function listPaymentCatalog(
  environment?: StripeEnvironment,
): Promise<ListPaymentCatalogResponse> {
  return readJson(await ossFetch(withQuery('/api/payments/catalog', { environment })));
}

export async function listPaymentProducts(
  environment: StripeEnvironment,
): Promise<ListPaymentProductsResponse> {
  return readJson(await ossFetch(withQuery('/api/payments/products', { environment })));
}

export async function getPaymentProduct(
  environment: StripeEnvironment,
  productId: string,
): Promise<GetPaymentProductResponse> {
  return readJson(await ossFetch(withQuery(
    `/api/payments/products/${encodeURIComponent(productId)}`,
    { environment },
  )));
}

export async function createPaymentProduct(
  request: CreatePaymentProductRequest,
): Promise<MutatePaymentProductResponse> {
  return readJson(await ossFetch('/api/payments/products', {
    method: 'POST',
    body: JSON.stringify(request),
  }));
}

export async function updatePaymentProduct(
  productId: string,
  request: UpdatePaymentProductRequest,
): Promise<MutatePaymentProductResponse> {
  return readJson(await ossFetch(`/api/payments/products/${encodeURIComponent(productId)}`, {
    method: 'PATCH',
    body: JSON.stringify(request),
  }));
}

export async function deletePaymentProduct(
  environment: StripeEnvironment,
  productId: string,
): Promise<DeletePaymentProductResponse> {
  return readJson(await ossFetch(withQuery(
    `/api/payments/products/${encodeURIComponent(productId)}`,
    { environment },
  ), { method: 'DELETE' }));
}

export async function listPaymentPrices(
  environment: StripeEnvironment,
  stripeProductId?: string,
): Promise<ListPaymentPricesResponse> {
  return readJson(await ossFetch(withQuery('/api/payments/prices', {
    environment,
    stripeProductId,
  })));
}

export async function getPaymentPrice(
  environment: StripeEnvironment,
  priceId: string,
): Promise<GetPaymentPriceResponse> {
  return readJson(await ossFetch(withQuery(
    `/api/payments/prices/${encodeURIComponent(priceId)}`,
    { environment },
  )));
}

export async function createPaymentPrice(
  request: CreatePaymentPriceRequest,
): Promise<MutatePaymentPriceResponse> {
  return readJson(await ossFetch('/api/payments/prices', {
    method: 'POST',
    body: JSON.stringify(request),
  }));
}

export async function updatePaymentPrice(
  priceId: string,
  request: UpdatePaymentPriceRequest,
): Promise<MutatePaymentPriceResponse> {
  return readJson(await ossFetch(`/api/payments/prices/${encodeURIComponent(priceId)}`, {
    method: 'PATCH',
    body: JSON.stringify(request),
  }));
}

export async function archivePaymentPrice(
  environment: StripeEnvironment,
  priceId: string,
): Promise<ArchivePaymentPriceResponse> {
  return readJson(await ossFetch(withQuery(
    `/api/payments/prices/${encodeURIComponent(priceId)}`,
    { environment },
  ), { method: 'DELETE' }));
}

export async function listSubscriptions(
  request: ListSubscriptionsRequest,
): Promise<ListSubscriptionsResponse> {
  return readJson(await ossFetch(withQuery('/api/payments/subscriptions', request)));
}

export async function listPaymentHistory(
  request: ListPaymentHistoryRequest,
): Promise<ListPaymentHistoryResponse> {
  return readJson(await ossFetch(withQuery('/api/payments/payment-history', request)));
}
