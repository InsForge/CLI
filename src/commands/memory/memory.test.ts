import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerMemoryCommands } from './index.js';

vi.mock('../../lib/api/oss.js', () => ({
  ossFetch: vi.fn(),
}));
vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => ({ accessToken: 'tok', userId: 'u' })),
}));
vi.mock('../../lib/config.js', () => ({
  getProjectConfig: vi.fn(() => ({
    project_id: 'p1',
    project_name: 'demo',
    org_id: 'o1',
    appkey: 'k',
    region: 'us-east',
    api_key: 'key',
    oss_host: 'http://localhost',
  })),
}));
vi.mock('../../lib/analytics.js', () => ({
  captureEvent: vi.fn(),
  shutdownAnalytics: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>');
  registerMemoryCommands(program.command('memory'));
  return program;
}

async function run(argv: string[]) {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await makeProgram().parseAsync(argv, { from: 'user' });
  } finally {
    logSpy.mockRestore();
  }
}

function mockResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('memory commands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('remember stores a single fact (not transcript) and honors --kind/--title', async () => {
    const { ossFetch } = await import('../../lib/api/oss.js');
    (ossFetch as Mock).mockResolvedValue(mockResponse({ results: [{ action: 'ADD', title: 'T' }] }));

    await run(['memory', 'remember', 'some content', '--scope', 's', '--kind', 'decision', '--title', 'T']);

    const [path, opts] = (ossFetch as Mock).mock.calls[0];
    expect(path).toBe('/api/memory/remember');
    const body = JSON.parse(opts?.body as string);
    expect(body).toMatchObject({ scope: 's', kind: 'decision', title: 'T', content: 'some content' });
    expect(body.transcript).toBeUndefined();

    const { captureEvent } = await import('../../lib/analytics.js');
    expect(captureEvent).toHaveBeenCalledWith('p1', 'cli_memory_remember', expect.objectContaining({ mode: 'single' }));
  });

  it('remember --transcript sends transcript mode', async () => {
    const { ossFetch } = await import('../../lib/api/oss.js');
    (ossFetch as Mock).mockResolvedValue(mockResponse({ results: [] }));

    await run(['memory', 'remember', 'a long transcript', '--transcript', '--scope', 's']);

    const body = JSON.parse((ossFetch as Mock).mock.calls[0][1]?.body as string);
    expect(body.transcript).toBe('a long transcript');
    expect(body.content).toBeUndefined();
  });

  it('recall posts the query to the recall endpoint', async () => {
    const { ossFetch } = await import('../../lib/api/oss.js');
    (ossFetch as Mock).mockResolvedValue(mockResponse({ memories: [] }));

    await run(['memory', 'recall', 'where is the secret', '--scope', 's', '--limit', '3']);

    const [path, opts] = (ossFetch as Mock).mock.calls[0];
    expect(path).toBe('/api/memory/recall');
    expect(JSON.parse(opts?.body as string)).toMatchObject({ scope: 's', query: 'where is the secret', limit: 3 });
  });

  it('list hits the index endpoint', async () => {
    const { ossFetch } = await import('../../lib/api/oss.js');
    (ossFetch as Mock).mockResolvedValue(mockResponse({ entries: [] }));

    await run(['memory', 'list', '--scope', 's']);

    expect((ossFetch as Mock).mock.calls[0][0]).toBe('/api/memory/index');
  });
});
