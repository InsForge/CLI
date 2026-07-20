import { ossFetch } from "./oss.js";
import type {
  ArchiveStripePriceResponse,
  ConfigureStripeWebhookResponse,
  CreateRazorpayItemBody,
  CreateRazorpayPlanBody,
  CreateStripePriceBody,
  CreateStripeProductBody,
  DeleteStripeProductResponse,
  GetRazorpayWebhookSetupResponse,
  GetRazorpayStatusResponse,
  GetStripePriceResponse,
  GetStripeProductResponse,
  GetStripeStatusResponse,
  ListPaymentCustomersRequest,
  ListPaymentCustomersResponse,
  ListPaymentTransactionsQuery,
  ListPaymentTransactionsResponse,
  ListRazorpayCatalogResponse,
  ListRazorpaySubscriptionsQuery,
  ListRazorpaySubscriptionsResponse,
  ListStripeCatalogResponse,
  ListStripePricesResponse,
  ListStripeProductsResponse,
  ListStripeSubscriptionsQuery,
  ListStripeSubscriptionsResponse,
  MutateRazorpayItemResponse,
  MutateRazorpayPlanResponse,
  MutateStripePriceResponse,
  MutateStripeProductResponse,
  PaymentEnvironment,
  PaymentProvider,
  RegenerateRazorpayWebhookSecretResponse,
  SyncRazorpayPaymentsRequest,
  SyncRazorpayPaymentsResponse,
  SyncStripePaymentsRequest,
  SyncStripePaymentsResponse,
  UpdateRazorpayItemBody,
  UpdateStripePriceBody,
  UpdateStripeProductBody,
  UpsertRazorpayConfigBody,
  UpsertStripeConfigBody,
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

function withProviderPath(provider: PaymentProvider, suffix: string): string {
  return `/api/payments/${encodeURIComponent(provider)}${suffix}`;
}

function withProviderEnvironmentPath(
  provider: PaymentProvider,
  environment: PaymentEnvironment,
  suffix: string,
): string {
  return withProviderPath(
    provider,
    `/${encodeURIComponent(environment)}${suffix}`,
  );
}

export async function getStripePaymentsStatus(): Promise<GetStripeStatusResponse> {
  return readJson(await ossFetch(withProviderPath("stripe", "/status")));
}

export async function getRazorpayPaymentsStatus(): Promise<GetRazorpayStatusResponse> {
  return readJson(await ossFetch(withProviderPath("razorpay", "/status")));
}

export async function setStripeSecretKey(
  environment: PaymentEnvironment,
  secretKey: string,
): Promise<void> {
  const request: UpsertStripeConfigBody = { secretKey };
  await ossFetch(withProviderEnvironmentPath("stripe", environment, "/config"), {
    method: "PUT",
    body: JSON.stringify(request),
  });
}

export async function setRazorpayKeys(
  environment: PaymentEnvironment,
  request: UpsertRazorpayConfigBody,
): Promise<void> {
  await ossFetch(
    withProviderEnvironmentPath("razorpay", environment, "/config"),
    {
      method: "PUT",
      body: JSON.stringify(request),
    },
  );
}

export async function removeStripeSecretKey(
  environment: PaymentEnvironment,
): Promise<void> {
  await ossFetch(withProviderEnvironmentPath("stripe", environment, "/config"), {
    method: "DELETE",
  });
}

export async function removeRazorpayKeys(
  environment: PaymentEnvironment,
): Promise<void> {
  await ossFetch(withProviderEnvironmentPath("razorpay", environment, "/config"), {
    method: "DELETE",
  });
}

export async function syncStripePayments(
  environment: SyncStripePaymentsRequest["environment"] = "all",
): Promise<SyncStripePaymentsResponse> {
  return readJson(
    await ossFetch(
      environment === "all"
        ? withProviderPath("stripe", "/sync")
        : withProviderEnvironmentPath("stripe", environment, "/sync"),
      { method: "POST" },
    ),
  );
}

export async function syncRazorpayPayments(
  environment: SyncRazorpayPaymentsRequest["environment"] = "all",
): Promise<SyncRazorpayPaymentsResponse> {
  return readJson(
    await ossFetch(
      environment === "all"
        ? withProviderPath("razorpay", "/sync")
        : withProviderEnvironmentPath("razorpay", environment, "/sync"),
      { method: "POST" },
    ),
  );
}

export async function configureStripeWebhook(
  environment: PaymentEnvironment,
): Promise<ConfigureStripeWebhookResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath("stripe", environment, "/webhook"),
      {
        method: "POST",
      },
    ),
  );
}

export async function getRazorpayWebhookSetup(
  environment: PaymentEnvironment,
): Promise<GetRazorpayWebhookSetupResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath("razorpay", environment, "/webhook"),
    ),
  );
}

export async function rotateRazorpayWebhookSecret(
  environment: PaymentEnvironment,
): Promise<RegenerateRazorpayWebhookSecretResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath(
        "razorpay",
        environment,
        "/webhook/rotate-secret",
      ),
      { method: "POST" },
    ),
  );
}

export async function listStripeCatalog(
  environment: PaymentEnvironment,
): Promise<ListStripeCatalogResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath("stripe", environment, "/catalog"),
    ),
  );
}

export async function listRazorpayCatalog(
  environment: PaymentEnvironment,
): Promise<ListRazorpayCatalogResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath("razorpay", environment, "/catalog"),
    ),
  );
}

export async function listStripeProducts(
  environment: PaymentEnvironment,
): Promise<ListStripeProductsResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath("stripe", environment, "/catalog/products"),
    ),
  );
}

export async function getStripeProduct(
  environment: PaymentEnvironment,
  productId: string,
): Promise<GetStripeProductResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath(
        "stripe",
        environment,
        `/catalog/products/${encodeURIComponent(productId)}`,
      ),
    ),
  );
}

export async function createStripeProduct(
  environment: PaymentEnvironment,
  request: CreateStripeProductBody,
): Promise<MutateStripeProductResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath("stripe", environment, "/catalog/products"),
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function updateStripeProduct(
  environment: PaymentEnvironment,
  productId: string,
  request: UpdateStripeProductBody,
): Promise<MutateStripeProductResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath(
        "stripe",
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

export async function deleteStripeProduct(
  environment: PaymentEnvironment,
  productId: string,
): Promise<DeleteStripeProductResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath(
        "stripe",
        environment,
        `/catalog/products/${encodeURIComponent(productId)}`,
      ),
      { method: "DELETE" },
    ),
  );
}

export async function listStripePrices(
  environment: PaymentEnvironment,
  productId?: string,
): Promise<ListStripePricesResponse> {
  return readJson(
    await ossFetch(
      withQuery(
        withProviderEnvironmentPath("stripe", environment, "/catalog/prices"),
        { productId },
      ),
    ),
  );
}

export async function getStripePrice(
  environment: PaymentEnvironment,
  priceId: string,
): Promise<GetStripePriceResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath(
        "stripe",
        environment,
        `/catalog/prices/${encodeURIComponent(priceId)}`,
      ),
    ),
  );
}

export async function createStripePrice(
  environment: PaymentEnvironment,
  request: CreateStripePriceBody,
): Promise<MutateStripePriceResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath("stripe", environment, "/catalog/prices"),
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function updateStripePrice(
  environment: PaymentEnvironment,
  priceId: string,
  request: UpdateStripePriceBody,
): Promise<MutateStripePriceResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath(
        "stripe",
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

export async function archiveStripePrice(
  environment: PaymentEnvironment,
  priceId: string,
): Promise<ArchiveStripePriceResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath(
        "stripe",
        environment,
        `/catalog/prices/${encodeURIComponent(priceId)}`,
      ),
      { method: "DELETE" },
    ),
  );
}

export async function createRazorpayItem(
  environment: PaymentEnvironment,
  request: CreateRazorpayItemBody,
): Promise<MutateRazorpayItemResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath("razorpay", environment, "/catalog/items"),
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function updateRazorpayItem(
  environment: PaymentEnvironment,
  itemId: string,
  request: UpdateRazorpayItemBody,
): Promise<MutateRazorpayItemResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath(
        "razorpay",
        environment,
        `/catalog/items/${encodeURIComponent(itemId)}`,
      ),
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function createRazorpayPlan(
  environment: PaymentEnvironment,
  request: CreateRazorpayPlanBody,
): Promise<MutateRazorpayPlanResponse> {
  return readJson(
    await ossFetch(
      withProviderEnvironmentPath("razorpay", environment, "/catalog/plans"),
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    ),
  );
}

export async function listStripeSubscriptions(
  environment: PaymentEnvironment,
  request: ListStripeSubscriptionsQuery,
): Promise<ListStripeSubscriptionsResponse> {
  return readJson(
    await ossFetch(
      withQuery(
        withProviderEnvironmentPath("stripe", environment, "/subscriptions"),
        request,
      ),
    ),
  );
}

export async function listRazorpaySubscriptions(
  environment: PaymentEnvironment,
  request: ListRazorpaySubscriptionsQuery,
): Promise<ListRazorpaySubscriptionsResponse> {
  return readJson(
    await ossFetch(
      withQuery(
        withProviderEnvironmentPath("razorpay", environment, "/subscriptions"),
        request,
      ),
    ),
  );
}

export async function listPaymentCustomers(
  provider: PaymentProvider,
  environment: PaymentEnvironment,
  request: ListPaymentCustomersQuery = {},
): Promise<ListPaymentCustomersResponse> {
  return readJson(
    await ossFetch(
      withQuery(
        withProviderEnvironmentPath(provider, environment, "/customers"),
        request,
      ),
    ),
  );
}

export async function listPaymentTransactions(
  provider: PaymentProvider,
  environment: PaymentEnvironment,
  request: ListPaymentTransactionsQuery,
): Promise<ListPaymentTransactionsResponse> {
  return readJson(
    await ossFetch(
      withQuery(
        withProviderEnvironmentPath(provider, environment, "/transactions"),
        request,
      ),
    ),
  );
}
