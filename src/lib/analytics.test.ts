import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

describe('analytics opt-out', () => {
  const savedTelemetry = process.env.INSFORGE_TELEMETRY;
  const savedKey = process.env.POSTHOG_API_KEY;

  beforeEach(() => {
    vi.resetModules();
    process.env.POSTHOG_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (savedTelemetry === undefined) delete process.env.INSFORGE_TELEMETRY;
    else process.env.INSFORGE_TELEMETRY = savedTelemetry;
    if (savedKey === undefined) delete process.env.POSTHOG_API_KEY;
    else process.env.POSTHOG_API_KEY = savedKey;
  });

  // Walks every opt-out value end-to-end through captureEvent: each must result
  // in a no-op, not a thrown error or a network call. The PostHog client is the
  // observable side effect, so we assert on its constructor count.
  for (const value of ['0', 'false', 'no', 'FALSE', 'No']) {
    it(`treats INSFORGE_TELEMETRY=${value} as off`, async () => {
      process.env.INSFORGE_TELEMETRY = value;
      const ctor = vi.fn();
      vi.doMock('posthog-node', () => ({
        PostHog: class {
          constructor() {
            ctor();
          }
          capture() {}
          shutdown() {
            return Promise.resolve();
          }
        },
      }));
      const { captureEvent, shutdownAnalytics } = await import('./analytics.js');
      captureEvent('user-x', 'cli_config_invoked', { subcommand: 'apply' });
      await shutdownAnalytics();
      expect(ctor).not.toHaveBeenCalled();
    });
  }

  it('emits when INSFORGE_TELEMETRY is unset', async () => {
    delete process.env.INSFORGE_TELEMETRY;
    const captureCalls: Array<unknown> = [];
    vi.doMock('posthog-node', () => ({
      PostHog: class {
        capture(payload: unknown) {
          captureCalls.push(payload);
        }
        shutdown() {
          return Promise.resolve();
        }
      },
    }));
    const { captureEvent, shutdownAnalytics } = await import('./analytics.js');
    captureEvent('user-x', 'cli_config_invoked', { subcommand: 'apply' });
    await shutdownAnalytics();
    expect(captureCalls).toHaveLength(1);
  });

  it('treats unrecognized INSFORGE_TELEMETRY values as on', async () => {
    process.env.INSFORGE_TELEMETRY = '1';
    const captureCalls: Array<unknown> = [];
    vi.doMock('posthog-node', () => ({
      PostHog: class {
        capture(payload: unknown) {
          captureCalls.push(payload);
        }
        shutdown() {
          return Promise.resolve();
        }
      },
    }));
    const { captureEvent, shutdownAnalytics } = await import('./analytics.js');
    captureEvent('user-x', 'cli_config_invoked', { subcommand: 'apply' });
    await shutdownAnalytics();
    expect(captureCalls).toHaveLength(1);
  });
});
