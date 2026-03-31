import { PostHog } from 'posthog-node';

const POSTHOG_API_KEY = 'phc_ueV1ii62wdBTkH7E70ugyeqHIHu8dFDdjs0qq3TZhJz';
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!POSTHOG_API_KEY) return null;
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST });
  }
  return client;
}

export function captureEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    getClient()?.capture({ distinctId, event, properties });
  } catch {
    // analytics should never break the CLI
  }
}

export async function shutdownAnalytics(): Promise<void> {
  try {
    if (client) await client.shutdown();
  } catch {
    // ignore
  }
}
