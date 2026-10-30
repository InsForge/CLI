import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1',
    project_name: 'Test Project',
    org_id: 'o1',
    region: 'us',
    api_key: 'secret',
    appkey: 'app',
    oss_host: 'https://app.us.insforge.app',
  })),
}));
vi.mock('../../lib/config.js', () => configMock);

// telemetry.ts imports command-telemetry.js, which in turn imports the group
// and top-level trackers from analytics.js, so the mock must export them too.
const analyticsMock = vi.hoisted(() => ({
  trackDomains: vi.fn(),
  trackGroupCommand: vi.fn(),
  trackTopLevelCommand: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));
vi.mock('../../lib/analytics.js', () => analyticsMock);

import { CLIError } from '../../lib/errors.js';
import { trackDomainUsage } from './telemetry.js';

describe('domain command telemetry', () => {
  beforeEach(() => {
    analyticsMock.trackDomains.mockClear();
    analyticsMock.shutdownAnalytics.mockClear();
    configMock.getProjectConfig.mockReturnValue({
      project_id: 'p1',
      project_name: 'Test Project',
      org_id: 'o1',
      region: 'us',
      api_key: 'secret',
      appkey: 'app',
      oss_host: 'https://app.us.insforge.app',
    });
  });

  it('tracks safe domain command fields and structured errors only', async () => {
    const error = new CLIError(
      'failed to register very-sensitive-example.dev',
      1,
      'DOMAIN_REGISTRATION_NOT_READY',
      409,
    );

    await trackDomainUsage('buy', false, {
      tld: '.DEV',
      poll_seconds: 90,
      confirmed: true,
      // Should be ignored if a caller accidentally passes it.
      domain: 'very-sensitive-example.dev',
    }, error);

    expect(analyticsMock.trackDomains).toHaveBeenCalledWith(
      'buy',
      expect.objectContaining({ project_id: 'p1' }),
      expect.objectContaining({
        success: false,
        tld: 'dev',
        poll_seconds: 90,
        confirmed: true,
        error_name: 'CLIError',
        error_code: 'DOMAIN_REGISTRATION_NOT_READY',
        exit_code: 1,
        status_code: 409,
      }),
    );

    const properties = analyticsMock.trackDomains.mock.calls[0]?.[2] as
      | Record<string, unknown>
      | undefined;
    expect(properties).not.toHaveProperty('domain');
    expect(properties).not.toHaveProperty('error_message');
    expect(analyticsMock.shutdownAnalytics).toHaveBeenCalledOnce();
  });
});
