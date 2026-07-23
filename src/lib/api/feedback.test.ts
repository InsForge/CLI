import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { submitFeedback, type FeedbackPayload } from './feedback.js';
import { CLIError } from '../errors.js';

const PAYLOAD: FeedbackPayload = {
  type: 'bug',
  component: 'cli',
  severity: 'minor',
  title: 't',
  detail: 'd',
  client_info: { source: 'cli', cli_version: 'test', node_version: 'v22', os: 'darwin' },
};

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('submitFeedback', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the payload with the anon key and a timeout signal', async () => {
    (fetch as Mock).mockResolvedValue(mockResponse(201, { id: 'fb1', status: 'received' }));

    const result = await submitFeedback(PAYLOAD);

    expect(result).toEqual({ id: 'fb1', status: 'received' });
    const [url, init] = (fetch as Mock).mock.calls[0];
    expect(String(url)).toContain('/functions/submit-feedback');
    expect(init.headers.Authorization).toMatch(/^Bearer anon_/);
    expect(JSON.parse(init.body)).toMatchObject({ type: 'bug', component: 'cli' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps duplicate responses', async () => {
    (fetch as Mock).mockResolvedValue(mockResponse(200, { id: 'fb1', status: 'duplicate' }));
    await expect(submitFeedback(PAYLOAD)).resolves.toEqual({ id: 'fb1', status: 'duplicate' });
  });

  it('surfaces server error messages as CLIError', async () => {
    (fetch as Mock).mockResolvedValue(
      mockResponse(429, { error: 'Rate limit exceeded — try again later' }),
    );
    await expect(submitFeedback(PAYLOAD)).rejects.toThrow('Rate limit exceeded');
    await expect(
      submitFeedback(PAYLOAD).catch((e) => Promise.reject(e)),
    ).rejects.toBeInstanceOf(CLIError);
  });

  it('maps timeouts to an actionable message', async () => {
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    (fetch as Mock).mockRejectedValue(timeoutErr);
    await expect(submitFeedback(PAYLOAD)).rejects.toThrow('timed out after 10s');
  });

  it('wraps network failures in CLIError', async () => {
    (fetch as Mock).mockRejectedValue(new Error('fetch failed'));
    await expect(submitFeedback(PAYLOAD)).rejects.toBeInstanceOf(CLIError);
  });
});
