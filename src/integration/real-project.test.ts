import { describe, expect, it } from 'vitest';
import {
  expectCliSuccess,
  expectNoErrorPayload,
  getLogSource,
  getOptionalApiUrl,
  parseJsonOutput,
  runCli,
} from './helpers.js';

const integrationEnabled = process.env.INTEGRATION_TEST_ENABLED === 'true';

describe.skipIf(!integrationEnabled)('CLI Real Project Integration (Phase 1, read-only)', () => {
  const apiUrl = getOptionalApiUrl();
  const logSource = getLogSource();

  it('whoami --json should return authenticated user', async () => {
    const result = await runCli(['--json', 'whoami'], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expectNoErrorPayload(payload);

    expect(typeof payload.id).toBe('string');
    expect(typeof payload.email).toBe('string');
    expect((payload.email as string).length).toBeGreaterThan(3);
  });

  it('metadata --json should return backend metadata structure', async () => {
    const result = await runCli(['--json', 'metadata'], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expectNoErrorPayload(payload);

    expect(payload).toHaveProperty('auth');
    expect(payload).toHaveProperty('database');
    expect(payload).toHaveProperty('storage');
    expect(payload).toHaveProperty('functions');
  });

  it('logs --json should return logs payload for configured source', async () => {
    const result = await runCli(['--json', 'logs', logSource, '--limit', '5'], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout);
    expectNoErrorPayload(payload);

    const isArray = Array.isArray(payload);
    const hasLogsKey = !!payload && typeof payload === 'object' && 'logs' in (payload as Record<string, unknown>);
    expect(isArray || hasLogsKey).toBe(true);
  });

  it('docs instructions --json should return non-empty documentation content', async () => {
    const result = await runCli(['--json', 'docs', 'instructions'], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expectNoErrorPayload(payload);

    const content = payload.content;
    expect(typeof content).toBe('string');
    expect((content as string).trim().length).toBeGreaterThan(20);
  });
});
