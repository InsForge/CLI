import {
  shutdownAnalytics,
  trackGroupCommand,
  trackTopLevelCommand,
} from './analytics.js';
import { getProjectConfig } from './config.js';
import { CLIError } from './errors.js';

/**
 * Shared PostHog telemetry helpers for CLI commands.
 *
 * Every command should emit exactly one event per invocation:
 *   - `trackCommandUsage(group, subcommand, success, props?, error?)` for
 *     commands that live under a group (`cli_<group>_invoked`).
 *   - `trackTopLevelUsage(command, success, props?, error?)` for standalone
 *     top-level commands (`cli_command_invoked`).
 *
 * Both read the linked project config (falling back to an anonymous distinct
 * ID when none is linked), sanitize the supplied properties to non-sensitive
 * scalars, attach error telemetry on failure, and flush PostHog in `finally`.
 * Telemetry must never affect command behavior, so everything is wrapped in a
 * try/catch and failures are swallowed.
 *
 * IMPORTANT: only pass non-sensitive metadata as `properties` — counts,
 * booleans, enums, exit/status codes. Never SQL, file contents, credentials,
 * resource names, or other user-entered free text.
 */
export type CommandTelemetry = Record<
  string,
  string | number | boolean | undefined
>;

const MAX_STRING_LENGTH = 80;

export function sanitizeTelemetry(properties: CommandTelemetry): CommandTelemetry {
  const sanitized: CommandTelemetry = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      sanitized[key] = value.slice(0, MAX_STRING_LENGTH);
    } else if (typeof value === 'number') {
      if (Number.isFinite(value)) sanitized[key] = value;
    } else if (typeof value === 'boolean') {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function getErrorTelemetry(error: unknown): CommandTelemetry {
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

function safeGetProjectConfig() {
  try {
    return getProjectConfig();
  } catch {
    return null;
  }
}

// Flushing must never surface as a command error. `shutdownAnalytics` already
// swallows its own failures today, but guarding here keeps that invariant even
// if its implementation changes.
async function flushTelemetry(): Promise<void> {
  try {
    await shutdownAnalytics();
  } catch {
    // Telemetry shutdown must never affect command behavior.
  }
}

// A CLI process handles exactly one command, which should emit exactly one
// outcome event. Once an outcome is recorded we suppress any further calls, so
// a failure thrown during output rendering (after the success event already
// fired) cannot double-emit success + failure for a single invocation.
let outcomeRecorded = false;

/** Test-only: reset the once-per-process outcome guard between cases. */
export function resetTelemetryOutcomeForTests(): void {
  outcomeRecorded = false;
}

/**
 * Track a grouped subcommand invocation (`cli_<group>_invoked`).
 */
export async function trackCommandUsage(
  group: string,
  subcommand: string,
  success: boolean,
  properties: CommandTelemetry = {},
  error?: unknown,
): Promise<void> {
  if (outcomeRecorded) return;
  outcomeRecorded = true;
  try {
    trackGroupCommand(group, subcommand, safeGetProjectConfig(), {
      success,
      ...sanitizeTelemetry({
        ...properties,
        ...(error !== undefined ? getErrorTelemetry(error) : {}),
      }),
    });
  } catch {
    // Telemetry should never affect command behavior.
  } finally {
    await flushTelemetry();
  }
}

/**
 * Track a standalone top-level command invocation (`cli_command_invoked`).
 */
export async function trackTopLevelUsage(
  command: string,
  success: boolean,
  properties: CommandTelemetry = {},
  error?: unknown,
): Promise<void> {
  if (outcomeRecorded) return;
  outcomeRecorded = true;
  try {
    trackTopLevelCommand(command, safeGetProjectConfig(), {
      success,
      ...sanitizeTelemetry({
        ...properties,
        ...(error !== undefined ? getErrorTelemetry(error) : {}),
      }),
    });
  } catch {
    // Telemetry should never affect command behavior.
  } finally {
    await flushTelemetry();
  }
}
