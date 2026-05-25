import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(),
  getCredentials: vi.fn(),
}));

vi.mock('../../lib/analytics.js', () => ({
  trackCompute: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

import { trackComputeUsage } from './utils.js';
import { getProjectConfig, getCredentials } from '../../lib/config.js';
import { trackCompute, shutdownAnalytics } from '../../lib/analytics.js';

const CONFIG = {
  project_id: 'p1',
  project_name: 'proj',
  org_id: 'o1',
  region: 'iad',
  appkey: 'k',
  api_key: 'key',
};

const mockProjectConfig = getProjectConfig as ReturnType<typeof vi.fn>;
const mockCredentials = getCredentials as ReturnType<typeof vi.fn>;

describe('trackComputeUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tracks the subcommand with success, user_id and extra props when a project is linked', async () => {
    mockProjectConfig.mockReturnValue(CONFIG);
    mockCredentials.mockReturnValue({ user: { id: 'u1' } });

    await trackComputeUsage('deploy', true, { cpu: 'shared-1x', memory: 512 });

    expect(trackCompute).toHaveBeenCalledWith('deploy', CONFIG, {
      success: true,
      user_id: 'u1',
      cpu: 'shared-1x',
      memory: 512,
    });
    expect(shutdownAnalytics).toHaveBeenCalledTimes(1);
  });

  it('forwards success:false', async () => {
    mockProjectConfig.mockReturnValue(CONFIG);
    mockCredentials.mockReturnValue({ user: { id: 'u1' } });

    await trackComputeUsage('stop', false);

    expect(trackCompute).toHaveBeenCalledWith(
      'stop',
      CONFIG,
      expect.objectContaining({ success: false, user_id: 'u1' }),
    );
  });

  it('still tracks with user_id undefined when no credentials are present', async () => {
    mockProjectConfig.mockReturnValue(CONFIG);
    mockCredentials.mockReturnValue(null);

    await trackComputeUsage('list', true);

    expect(trackCompute).toHaveBeenCalledWith(
      'list',
      CONFIG,
      expect.objectContaining({ success: true, user_id: undefined }),
    );
  });

  it('does not track when no project is linked but still flushes analytics', async () => {
    mockProjectConfig.mockReturnValue(null);

    await trackComputeUsage('get', true);

    expect(trackCompute).not.toHaveBeenCalled();
    expect(shutdownAnalytics).toHaveBeenCalledTimes(1);
  });

  it('never throws and always flushes even if config lookup fails', async () => {
    mockProjectConfig.mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(trackComputeUsage('delete', true)).resolves.toBeUndefined();
    expect(trackCompute).not.toHaveBeenCalled();
    expect(shutdownAnalytics).toHaveBeenCalledTimes(1);
  });
});
