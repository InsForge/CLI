import { shutdownAnalytics, trackDomains } from '../../lib/analytics.js';
import { getErrorTelemetry } from '../../lib/command-telemetry.js';
import { getProjectConfig } from '../../lib/config.js';

export type DomainCommandTelemetry = Record<string, string | number | boolean | undefined>;

const STRING_KEYS = new Set([
  'tld',
  'registration_state',
  'error_name',
  'error_code',
]);

const NUMBER_KEYS = new Set([
  'account_count',
  'exit_code',
  'poll_seconds',
  'result_count',
  'status_code',
]);

const BOOLEAN_KEYS = new Set([
  'account_id_provided',
  'cloudflare',
  'confirmed',
  'has_tlds_filter',
  'registration_completed',
]);

function sanitizeTld(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/^\./, '');
  return /^[a-z0-9-]{2,63}$/.test(normalized) ? normalized : undefined;
}

function sanitizeDomainTelemetry(properties: DomainCommandTelemetry): DomainCommandTelemetry {
  const sanitized: DomainCommandTelemetry = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    if (key === 'tld' && typeof value === 'string') {
      const tld = sanitizeTld(value);
      if (tld) sanitized.tld = tld;
      continue;
    }
    if (STRING_KEYS.has(key) && typeof value === 'string') {
      sanitized[key] = value.slice(0, 80);
      continue;
    }
    if (NUMBER_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      sanitized[key] = value;
      continue;
    }
    if (BOOLEAN_KEYS.has(key) && typeof value === 'boolean') {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export async function trackDomainUsage(
  subcommand: string,
  success: boolean,
  properties: DomainCommandTelemetry = {},
  error?: unknown,
): Promise<void> {
  try {
    trackDomains(subcommand, getProjectConfig(), {
      success,
      ...sanitizeDomainTelemetry({
        ...properties,
        ...(error !== undefined ? getErrorTelemetry(error) : {}),
      }),
    });
  } catch {
    // Telemetry should never affect command behavior.
  } finally {
    await shutdownAnalytics();
  }
}
