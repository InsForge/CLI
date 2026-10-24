import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

const captureMock = vi.fn();
// A class, not vi.fn(() => ...): analytics.ts calls `new PostHog(...)`, and
// an arrow-function mock implementation is not constructable.
vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = captureMock;
    shutdown = vi.fn();
  },
}));
vi.mock('./config.js', () => ({
  FAKE_PROJECT_ID: 'fa4e0000-1234-5678-90ab-cd1234567890',
  getGlobalConfig: vi.fn(() => ({ platform_api_url: 'https://api.insforge.dev' })),
}));

async function loadAnalytics() {
  // Fresh module per test: POSTHOG_API_KEY is read at module load and the
  // PostHog client is cached in module state.
  vi.resetModules();
  return await import('./analytics.js');
}

describe('telemetry opt-out', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('POSTHOG_API_KEY', 'test-key');
    vi.stubEnv('DO_NOT_TRACK', '');
    vi.stubEnv('INSFORGE_TELEMETRY_DISABLED', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends events by default', async () => {
    const { captureEvent } = await loadAnalytics();
    captureEvent('p1', 'cli_test_event', { command: 'x' });
    expect(captureMock).toHaveBeenCalledOnce();
  });

  it('respects DO_NOT_TRACK', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    const { captureEvent, isTelemetryDisabled } = await loadAnalytics();
    expect(isTelemetryDisabled()).toBe(true);
    captureEvent('p1', 'cli_test_event');
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('respects INSFORGE_TELEMETRY_DISABLED', async () => {
    vi.stubEnv('INSFORGE_TELEMETRY_DISABLED', 'true');
    const { captureEvent, isTelemetryDisabled } = await loadAnalytics();
    expect(isTelemetryDisabled()).toBe(true);
    captureEvent('p1', 'cli_test_event');
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('treats explicit falsy env values as not opting out', async () => {
    vi.stubEnv('DO_NOT_TRACK', '0');
    vi.stubEnv('INSFORGE_TELEMETRY_DISABLED', 'false');
    const { isTelemetryDisabled } = await loadAnalytics();
    expect(isTelemetryDisabled()).toBe(false);
  });

  it('respects the persistent config opt-out', async () => {
    const { getGlobalConfig } = await import('./config.js');
    (getGlobalConfig as Mock).mockReturnValue({
      platform_api_url: 'https://api.insforge.dev',
      telemetry_disabled: true,
    });
    const { captureEvent, isTelemetryDisabled } = await loadAnalytics();
    expect(isTelemetryDisabled()).toBe(true);
    captureEvent('p1', 'cli_test_event');
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('stays enabled when the config file is unreadable', async () => {
    const { getGlobalConfig } = await import('./config.js');
    (getGlobalConfig as Mock).mockImplementation(() => {
      throw new Error('corrupt json');
    });
    const { isTelemetryDisabled } = await loadAnalytics();
    expect(isTelemetryDisabled()).toBe(false);
  });
});
