import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../lib/api/oss.js', () => ({
  ossFetch: vi.fn(async () => ({ json: async () => ({ name: 'svc', status: 'stopped' }) })),
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ access_token: 'tok', user: { id: 'u1' } })),
}));

vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1',
    project_name: 'proj',
    org_id: 'o1',
    region: 'iad',
    appkey: 'k',
    api_key: 'key',
  })),
  getCredentials: vi.fn(() => ({ user: { id: 'u1' } })),
}));

vi.mock('../../lib/analytics.js', () => ({
  trackCompute: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

vi.mock('../../lib/skills.js', () => ({
  reportCliUsage: vi.fn(async () => {}),
}));

import { registerComputeStopCommand } from './stop.js';
import { ossFetch } from '../../lib/api/oss.js';
import { trackCompute } from '../../lib/analytics.js';

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>').option('-y, --yes');
  const computeCmd = program.command('compute');
  registerComputeStopCommand(computeCmd);
  return program;
}

describe('compute stop analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tracks cli_compute stop with success and the user id on the happy path', async () => {
    const program = makeProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync(['compute', 'stop', 'svc-1', '--json'], { from: 'user' });
    } finally {
      logSpy.mockRestore();
    }

    expect(ossFetch).toHaveBeenCalled();
    expect(trackCompute).toHaveBeenCalledWith(
      'stop',
      expect.objectContaining({ project_id: 'p1' }),
      expect.objectContaining({ success: true, user_id: 'u1' }),
    );
  });
});
