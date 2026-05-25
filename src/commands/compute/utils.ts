import { getCredentials, getProjectConfig } from '../../lib/config.js';
import { shutdownAnalytics, trackCompute } from '../../lib/analytics.js';

export type ComputeCommandTelemetry = Record<
  string,
  string | number | boolean | undefined
>;

// Fire a `cli_compute_invoked` PostHog event for a compute subcommand.
// Mirrors `trackPaymentUsage` in ../payments/utils.ts: the event is keyed on
// the linked project (distinct id) and also carries the acting user's id so
// usage can be broken down per user. Telemetry must never change command
// behavior, so everything here is best-effort and swallowed on failure, and
// analytics are always flushed in the `finally` before the process exits.
export async function trackComputeUsage(
  subcommand: string,
  success: boolean,
  properties: ComputeCommandTelemetry = {},
): Promise<void> {
  try {
    try {
      const config = getProjectConfig();
      if (config) {
        let userId: string | undefined;
        try {
          userId = getCredentials()?.user?.id;
        } catch {
          // User id is best-effort metadata; never block telemetry on it.
        }
        trackCompute(subcommand, config, {
          success,
          user_id: userId,
          ...properties,
        });
      }
    } catch {
      // Telemetry should never affect command behavior.
    }
  } finally {
    await shutdownAnalytics();
  }
}
