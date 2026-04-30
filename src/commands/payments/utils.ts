import type { StripeEnvironment } from '@insforge/shared-schemas';
import { getProjectConfig } from '../../lib/config.js';
import { CLIError } from '../../lib/errors.js';
import { shutdownAnalytics, trackPayments } from '../../lib/analytics.js';

export type PaymentCommandTelemetry = Record<string, string | number | boolean | undefined>;

export function parseEnvironment(value: string): StripeEnvironment {
  if (value === 'test' || value === 'live') return value;
  throw new CLIError('Environment must be "test" or "live".');
}

export function parseEnvironmentOrAll(value: string): StripeEnvironment | 'all' {
  if (value === 'all') return value;
  return parseEnvironment(value);
}

export function parseBooleanOption(value: string | undefined, flagName: string): boolean | undefined {
  if (value === undefined) return undefined;

  const normalized = value.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  throw new CLIError(`${flagName} must be "true" or "false".`);
}

export function parseIntegerOption(
  value: string | undefined,
  flagName: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined) return undefined;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value.trim()) {
    throw new CLIError(`${flagName} must be an integer.`);
  }
  if (options.min !== undefined && parsed < options.min) {
    throw new CLIError(`${flagName} must be at least ${options.min}.`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new CLIError(`${flagName} must be at most ${options.max}.`);
  }
  return parsed;
}

export function parseMetadataOption(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CLIError('Invalid JSON for --metadata.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CLIError('--metadata must be a JSON object.');
  }

  const metadata: Record<string, string> = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (typeof raw !== 'string') {
      throw new CLIError(`Metadata value for "${key}" must be a string.`);
    }
    metadata[key] = raw;
  }

  return metadata;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatAmount(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount === null || amount === undefined) return '-';
  const code = currency?.toUpperCase();
  let fractionDigits = 2;

  if (code) {
    try {
      fractionDigits = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code,
      }).resolvedOptions().maximumFractionDigits;
    } catch {
      fractionDigits = 2;
    }
  }

  const divisor = 10 ** fractionDigits;
  return `${(amount / divisor).toFixed(fractionDigits)} ${code ?? ''}`.trim();
}

export function formatRecurring(
  interval: string | null | undefined,
  intervalCount: number | null | undefined,
): string {
  if (!interval) return 'one-time';
  return `${intervalCount && intervalCount > 1 ? `${intervalCount} ` : ''}${interval}`;
}

export async function trackPaymentUsage(
  subcommand: string,
  success: boolean,
  properties: PaymentCommandTelemetry = {},
): Promise<void> {
  try {
    try {
      const config = getProjectConfig();
      if (config) {
        trackPayments(subcommand, config, {
          success,
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
