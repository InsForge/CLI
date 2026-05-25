import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../lib/api/oss.js', () => ({
  ossFetch: vi.fn(),
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

import { registerComputeDeployCommand } from './deploy.js';
import { ossFetch } from '../../lib/api/oss.js';
import { trackCompute } from '../../lib/analytics.js';

const mockOssFetch = ossFetch as ReturnType<typeof vi.fn>;
const mockTrackCompute = trackCompute as ReturnType<typeof vi.fn>;

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>').option('-y, --yes');
  const computeCmd = program.command('compute');
  registerComputeDeployCommand(computeCmd);
  return program;
}

describe('compute deploy analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Image mode makes two calls in order: list (→ [] = no existing service),
    // then POST (→ the created service).
    mockOssFetch
      .mockResolvedValueOnce({ json: async () => [] })
      .mockResolvedValueOnce({
        json: async () => ({ name: 'api', status: 'creating', port: 8080 }),
      });
  });

  it('tracks deploy with safe metadata only — no image url or env values leak', async () => {
    const program = makeProgram();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await program.parseAsync(
        [
          'compute', 'deploy',
          '--name', 'api',
          '--image', 'registry.example.com/secret/api:1.2.3',
          '--cpu', 'shared-1x',
          '--memory', '512',
          '--region', 'iad',
          '--port', '8080',
          '--env', '{"SECRET_TOKEN":"hunter2"}',
          '--json',
        ],
        { from: 'user' },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(mockTrackCompute).toHaveBeenCalledTimes(1);
    const [subcommand, config, props] = mockTrackCompute.mock.calls[0];
    expect(subcommand).toBe('deploy');
    expect(config).toMatchObject({ project_id: 'p1' });
    expect(props).toMatchObject({
      success: true,
      user_id: 'u1',
      mode: 'image',
      cpu: 'shared-1x',
      memory: 512,
      region: 'iad',
      port: 8080,
      has_env: true,
    });
    // Never ship the image URL or env var values/contents.
    expect(props).not.toHaveProperty('image');
    expect(props).not.toHaveProperty('imageUrl');
    expect(props).not.toHaveProperty('env');
    expect(props).not.toHaveProperty('envVars');
    expect(JSON.stringify(props)).not.toContain('hunter2');
    expect(JSON.stringify(props)).not.toContain('registry.example.com');
  });
});
