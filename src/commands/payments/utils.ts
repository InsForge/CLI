import type {
  PaymentEnvironment,
  RazorpayPlanPeriod,
} from "@insforge/shared-schemas";
import { getProjectConfig } from "../../lib/config.js";
import { CLIError } from "../../lib/errors.js";
import { shutdownAnalytics, trackPayments } from "../../lib/analytics.js";

export type PaymentCommandTelemetry = Record<
  string,
  string | number | boolean | undefined
>;

function sanitizePaymentTelemetry(
  properties: PaymentCommandTelemetry,
): PaymentCommandTelemetry {
  const sanitized: PaymentCommandTelemetry = {};

  if (properties.provider === "stripe" || properties.provider === "razorpay") {
    sanitized.provider = properties.provider;
  }

  if (
    properties.environment === "test" ||
    properties.environment === "live" ||
    properties.environment === "all"
  ) {
    sanitized.environment = properties.environment;
  } else if (properties.environment !== undefined) {
    sanitized.environment_valid = false;
  }

  if (typeof properties.error_name === "string") {
    sanitized.error_name = properties.error_name;
  }
  if (typeof properties.error_code === "string") {
    sanitized.error_code = properties.error_code;
  }
  if (typeof properties.exit_code === "number") {
    sanitized.exit_code = properties.exit_code;
  }
  if (typeof properties.status_code === "number") {
    sanitized.status_code = properties.status_code;
  }

  return sanitized;
}

function getErrorTelemetry(error: unknown): PaymentCommandTelemetry {
  return {
    error_name: error instanceof Error ? error.name : typeof error,
    ...(error instanceof CLIError
      ? {
          error_code: error.code,
          exit_code: error.exitCode,
          status_code: error.statusCode,
        }
      : {}),
  };
}

export function parseEnvironment(value: string): PaymentEnvironment {
  if (value === "test" || value === "live") return value;
  throw new CLIError('Environment must be "test" or "live".');
}

export function parseEnvironmentOrAll(
  value: string,
): PaymentEnvironment | "all" {
  if (value === "all") return value;
  return parseEnvironment(value);
}

export function parseRazorpayPlanPeriod(
  value: string | undefined,
): RazorpayPlanPeriod | undefined {
  if (value === undefined) return undefined;
  if (
    value === "daily" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "yearly"
  ) {
    return value;
  }
  throw new CLIError(
    "--period must be one of: daily, weekly, monthly, yearly.",
  );
}

export function parseRequiredRazorpayPlanPeriod(
  value: string | undefined,
): RazorpayPlanPeriod {
  const period = parseRazorpayPlanPeriod(value);
  if (period === undefined) throw new CLIError("Provide --period.");
  return period;
}

export function nullableString(
  value: string | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  return value === "null" ? null : value;
}

export function parseBooleanOption(
  value: string | undefined,
  flagName: string,
): boolean | undefined {
  if (value === undefined) return undefined;

  const normalized = value.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;

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

export function parseRequiredIntegerOption(
  value: string | undefined,
  flagName: string,
  options: { min?: number; max?: number } = {},
): number {
  const parsed = parseIntegerOption(value, flagName, options);
  if (parsed === undefined) throw new CLIError(`Provide ${flagName}.`);
  return parsed;
}

function parseStringRecordOption(
  value: string | undefined,
  flagName: string,
  fieldName: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CLIError(`Invalid JSON for ${flagName}.`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CLIError(`${flagName} must be a JSON object.`);
  }

  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (typeof raw !== "string") {
      throw new CLIError(`${fieldName} value for "${key}" must be a string.`);
    }
    result[key] = raw;
  }

  return result;
}

export function parseMetadataOption(
  value: string | undefined,
): Record<string, string> | undefined {
  return parseStringRecordOption(value, "--metadata", "Metadata");
}

export function parseNotesOption(
  value: string | undefined,
): Record<string, string> | undefined {
  return parseStringRecordOption(value, "--notes", "Notes");
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatAmount(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount === null || amount === undefined) return "-";
  const code = currency?.toUpperCase();
  let fractionDigits = 2;

  if (code) {
    try {
      fractionDigits =
        new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: code,
        }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      fractionDigits = 2;
    }
  }

  const divisor = 10 ** fractionDigits;
  return `${(amount / divisor).toFixed(fractionDigits)} ${code ?? ""}`.trim();
}

export function formatRecurring(
  interval: string | null | undefined,
  intervalCount: number | null | undefined,
): string {
  if (!interval) return "one-time";
  return `${intervalCount && intervalCount > 1 ? `${intervalCount} ` : ""}${interval}`;
}

export async function trackPaymentUsage(
  subcommand: string,
  success: boolean,
  properties: PaymentCommandTelemetry = {},
  error?: unknown,
): Promise<void> {
  try {
    const config = getProjectConfig();
    if (config) {
      trackPayments(subcommand, config, {
        success,
        ...sanitizePaymentTelemetry({
          ...properties,
          ...(error !== undefined ? getErrorTelemetry(error) : {}),
        }),
      });
    }
  } catch {
    // Telemetry should never affect command behavior.
  } finally {
    await shutdownAnalytics();
  }
}
