import { ossFetch } from "./oss.js";
import type {
  ArchivePaymentPriceResponse,
  ConfigurePaymentWebhookResponse,
  CreatePaymentPriceBody,
  CreatePaymentProductBody,
  DeletePaymentProductResponse,
  GetPaymentPriceResponse,
  GetPaymentProductResponse,
  GetPaymentsConfigResponse,
  GetPaymentsStatusResponse,
  ListPaymentCatalogResponse,
  ListPaymentCustomersRequest,
  ListPaymentCustomersResponse,
  ListPaymentHistoryQuery,
  ListPaymentHistoryResponse,
  ListPaymentPricesResponse,
  ListPaymentProductsResponse,
  ListSubscriptionsQuery,
  ListSubscriptionsResponse,
  MutatePaymentPriceResponse,
  MutatePaymentProductResponse,
  StripeEnvironment,
  SyncPaymentsRequest,
  SyncPaymentsResponse,
  UpdatePaymentPriceBody,
  UpdatePaymentProductBody,
} from "@insforge/shared-schemas";
type ListPaymentCustomersQuery = Partial<
  Omit<ListPaymentCustomersRequest, "environment">
>;

function withQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function withEnvironmentPath(
  environment: StripeEnvironment,
  suffix: string,
): string {
  return `/api/payments/${encodeURIComponent(environment)}${suffix}`;
}

export async function getPaymentsStatus(): Promise<GetPaymentsStatusResponse> {
  return readJson(await ossFetch("/api/payments/status"));
}

export async function getPaymentsConfig(): Promise<GetPaymentsConfigResponse> {
  return readJson(await ossFetch("/api/payments/config"));
}

export async function setStripeSecretKey(
  environment: StripeEnvironment,
  secretKey: string,
): Promise<GetPaymentsConfigResponse> {
  return readJson(
    await ossFetch(withEnvironmentPath(environment, "/config"), {
      method: "PUT",
      body: JSON.stringify({ secretKey }),
    }),
  );
}

export async function removeStripeSecretKey(
  environment: StripeEnvironment,
): Promise<GetPaymentsConfigResponse> {
  return readJson(
    await ossFetch(withEnvironmentPath(environment, "/config"), {
      method: "DELETE",
    }),
  );
}

export async function syncPayments(
  environment: SyncPaymentsRequest["environment"] = "all",
): Promise<SyncPaymentsResponse> {
  return readJson(
    await ossFetch(
      environment === "all"
        ? "/api/payments/sync"
        : withEnvironmentPath(environment, "/sync"),
      { method: "POST" },
    ),
  );
}

export async function configurePaymentWebhook(
  environment: StripeEnvironment,
): Promise<ConfigurePaymentWebhookResponse> {
  return readJson(
    await ossFetch(withEnvironmentPath(environment, "/webhook"), {
      method: "POST",
    }),
  );
}

export async function listPaymentCatalog(
  environment: StripeEnvironment,
): Promise<ListPaymentCatalogResponse> {
  return readJson(await ossFetch(withEnvironmentPath(environment, "/catalog")));
}

export async function listPaymentProducts(
  environment: StripeEnvironment,
): Promise<ListPaymentProductsResponse> {
  return readJson(
    await ossFetch(withEnvironmentPath(environment, "/catalog/products")),
  );
}

export async function getPaymentProduct(
  environment: StripeEnvironment,
  productId: string,
): Promise<GetPaymentProductResponse> {
  return readJson(
    await ossFetch(
      withEnvironmentPath(
        environment,
        `/catalog/products/${encodeURIComponent(productId)}`,
      ),
    ),
  );
}

export async function createPaymentProduct(
  environment: StripeEnvironment,
  request: CreatePaymentProductBody,
): Promise<MutatePaymentProductResponse> {
  return readJson(
    await ossFetch(withEnvironmentPath(environment, "/catalog/products"), {
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
}

export async function updatePaymentProduct(
  environment: StripeEnvironment,
  productId: string,
  request: UpdatePaymentProductBody,
): Promise<MutatePaymentProductResponse> {
  return readJson(
    await ossFetch(
      withEnvironmentPath(
        environment,
        `/catalog/products/${encodeURIComponent(productId)}`,
      ),
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function deletePaymentProduct(
  environment: StripeEnvironment,
  productId: string,
): Promise<DeletePaymentProductResponse> {
  return readJson(
    await ossFetch(
      withEnvironmentPath(
        environment,
        `/catalog/products/${encodeURIComponent(productId)}`,
      ),
      { method: "DELETE" },
    ),
  );
}

export async function listPaymentPrices(
  environment: StripeEnvironment,
  stripeProductId?: string,
): Promise<ListPaymentPricesResponse> {
  return readJson(
    await ossFetch(
      withQuery(withEnvironmentPath(environment, "/catalog/prices"), {
        stripeProductId,
      }),
    ),
  );
}

export async function getPaymentPrice(
  environment: StripeEnvironment,
  priceId: string,
): Promise<GetPaymentPriceResponse> {
  return readJson(
    await ossFetch(
      withEnvironmentPath(
        environment,
        `/catalog/prices/${encodeURIComponent(priceId)}`,
      ),
    ),
  );
}

export async function createPaymentPrice(
  environment: StripeEnvironment,
  request: CreatePaymentPriceBody,
): Promise<MutatePaymentPriceResponse> {
  return readJson(
    await ossFetch(withEnvironmentPath(environment, "/catalog/prices"), {
      method: "POST",
      body: JSON.stringify(request),
    }),
  );
}

export async function updatePaymentPrice(
  environment: StripeEnvironment,
  priceId: string,
  request: UpdatePaymentPriceBody,
): Promise<MutatePaymentPriceResponse> {
  return readJson(
    await ossFetch(
      withEnvironmentPath(
        environment,
        `/catalog/prices/${encodeURIComponent(priceId)}`,
      ),
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function archivePaymentPrice(
  environment: StripeEnvironment,
  priceId: string,
): Promise<ArchivePaymentPriceResponse> {
  return readJson(
    await ossFetch(
      withEnvironmentPath(
        environment,
        `/catalog/prices/${encodeURIComponent(priceId)}`,
      ),
      { method: "DELETE" },
    ),
  );
}

export async function listSubscriptions(
  environment: StripeEnvironment,
  request: ListSubscriptionsQuery,
): Promise<ListSubscriptionsResponse> {
  return readJson(
    await ossFetch(
      withQuery(withEnvironmentPath(environment, "/subscriptions"), request),
    ),
  );
}

export async function listPaymentCustomers(
  environment: StripeEnvironment,
  request: ListPaymentCustomersQuery = {},
): Promise<ListPaymentCustomersResponse> {
  return readJson(
    await ossFetch(
      withQuery(withEnvironmentPath(environment, "/customers"), request),
    ),
  );
}

export async function listPaymentHistory(
  environment: StripeEnvironment,
  request: ListPaymentHistoryQuery,
): Promise<ListPaymentHistoryResponse> {
  return readJson(
    await ossFetch(
      withQuery(withEnvironmentPath(environment, "/payment-history"), request),
    ),
  );
}
