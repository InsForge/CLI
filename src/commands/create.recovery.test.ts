import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { CLIError, isTransientApiError } from '../lib/errors.js';

vi.mock('../lib/api/platform.js', () => ({
  listOrganizations: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  getProjectApiKey: vi.fn(),
  NETWORK_ERROR_CODE: 'NETWORK_ERROR',
}));

import {
  createProjectOrReportAmbiguousResult,
  isAmbiguousProjectCreateFailure,
  waitForProjectActive,
} from './create.js';

const createdProject = {
  id: 'project-id',
  organization_id: 'org-id',
  name: 'demo',
  appkey: 'demo-appkey',
  region: 'eu-central',
  status: 'creating',
  instance_type: 'shared',
  service_version: null,
  customized_domain: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('create project recovery', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const platform = await import('../lib/api/platform.js');
    (platform.createProject as Mock).mockResolvedValue(createdProject);
    (platform.getProject as Mock).mockResolvedValue({ ...createdProject, status: 'active' });
  });

  it('reports an unknown result after a gateway failure without adopting a project', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.createProject as Mock).mockRejectedValueOnce(
      new CLIError('Request failed: 502', 1, undefined, 502),
    );

    await expect(createProjectOrReportAmbiguousResult('org-id', 'demo', 'eu-central', undefined))
      .rejects.toMatchObject({
        code: 'PROJECT_CREATE_RESULT_UNKNOWN',
        statusCode: 502,
        message: expect.stringContaining('npx @insforge/cli list --json'),
      });
  });

  it('reports an unknown result when the create response cannot be decoded', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.createProject as Mock).mockRejectedValueOnce(new SyntaxError('Unexpected end of JSON input'));

    await expect(createProjectOrReportAmbiguousResult('org-id', 'demo', 'eu-central', undefined))
      .rejects.toMatchObject({
        code: 'PROJECT_CREATE_RESULT_UNKNOWN',
        message: expect.stringContaining('npx @insforge/cli list --json'),
      });
  });

  it('keeps a one-off Platform endpoint in the recovery command', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.createProject as Mock).mockRejectedValueOnce(
      new CLIError('Request failed: 502', 1, undefined, 502),
    );

    await expect(createProjectOrReportAmbiguousResult(
      'org-id', 'demo', 'eu-central', 'https://platform.example.test',
    )).rejects.toMatchObject({
      message: expect.stringContaining(
        'npx @insforge/cli --api-url YOUR_API_URL list --json',
      ),
    });
  });

  it('prevents shell expansion in a custom endpoint', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.createProject as Mock).mockRejectedValueOnce(
      new CLIError('Request failed: 502', 1, undefined, 502),
    );
    const apiUrl = 'https://platform.example.test/$(whoami)`touch-pwned`';

    const error = await createProjectOrReportAmbiguousResult('org-id', 'demo', 'eu-central', apiUrl)
      .catch(err => err as CLIError);

    expect(error.message).toContain(
      'npx @insforge/cli --api-url YOUR_API_URL list --json',
    );
    expect(error.message).toContain('replacing `YOUR_API_URL` with the exact value used for creation');
    expect(error.message).not.toContain(apiUrl);
  });

  it('never reconciles an ordinary API 500', async () => {
    const platform = await import('../lib/api/platform.js');
    const failure = new CLIError('Internal server error', 1, undefined, 500);
    (platform.createProject as Mock).mockRejectedValueOnce(failure);

    await expect(createProjectOrReportAmbiguousResult('org-id', 'demo', 'eu-central', undefined))
      .rejects.toBe(failure);
  });

  it('recognizes only gateway and transport failures as ambiguous', () => {
    expect(isAmbiguousProjectCreateFailure(new CLIError('network', 1, 'NETWORK_ERROR'))).toBe(true);
    expect(isAmbiguousProjectCreateFailure(new CLIError('gateway', 1, undefined, 503))).toBe(true);
    expect(isAmbiguousProjectCreateFailure(new CLIError('invalid request', 1, undefined, 400))).toBe(false);
    expect(isAmbiguousProjectCreateFailure(new CLIError('server error', 1, undefined, 500))).toBe(false);
    expect(isAmbiguousProjectCreateFailure(new SyntaxError('Unexpected end of JSON input'))).toBe(true);
  });

  it('continues polling through three transient activation-read failures when the project recovers', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.getProject as Mock)
      .mockRejectedValueOnce(new CLIError('Request failed: 502', 1, undefined, 502))
      .mockRejectedValueOnce(new CLIError('Request failed: 502', 1, undefined, 502))
      .mockRejectedValueOnce(new CLIError('Request failed: 502', 1, undefined, 502))
      .mockResolvedValueOnce({ ...createdProject, status: 'active' });
    vi.useFakeTimers();
    try {
      const pending = waitForProjectActive('project-id');
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(platform.getProject).toHaveBeenCalledTimes(4);
  });

  it('preserves the last actionable error when the activation deadline expires', async () => {
    const platform = await import('../lib/api/platform.js');
    (platform.getProject as Mock).mockRejectedValue(
      new CLIError('Request failed: 502', 1, undefined, 502),
    );
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const pending = waitForProjectActive('project-id', undefined, 10_000)
        .catch(err => err as CLIError);
      await vi.runAllTimersAsync();
      const timeout = await pending;
      expect(timeout).toMatchObject({
        code: 'PROJECT_ACTIVATION_TIMEOUT',
        message: expect.stringContaining('Last control-plane error: Request failed: 502'),
      });
      expect(timeout.statusCode).toBeUndefined();
      expect(isTransientApiError(timeout)).toBe(false);
      expect(Date.now() - startedAt).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
    expect(platform.getProject).toHaveBeenCalledTimes(4);
  });

  it('aborts an in-flight status request at the activation deadline', async () => {
    const platform = await import('../lib/api/platform.js');
    let requestSignal: AbortSignal | undefined;
    (platform.getProject as Mock).mockImplementation(
      (_projectId: string, _apiUrl: string | undefined, signal: AbortSignal) => new Promise((_, reject) => {
        requestSignal = signal;
        signal.addEventListener('abort', () => {
          reject(new CLIError('Request aborted', 1, 'NETWORK_ERROR'));
        });
      }),
    );
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const pending = waitForProjectActive('project-id', undefined, 10_000)
        .catch(err => err as CLIError);
      await vi.advanceTimersByTimeAsync(10_000);
      const timeout = await pending;
      expect(timeout.code).toBe('PROJECT_ACTIVATION_TIMEOUT');
      expect(requestSignal?.aborted).toBe(true);
      expect(Date.now() - startedAt).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
