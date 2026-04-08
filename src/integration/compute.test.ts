import { describe, expect, it, afterAll } from 'vitest';
import {
  expectCliSuccess,
  expectNoErrorPayload,
  getOptionalApiUrl,
  parseJsonOutput,
  runCli,
} from './helpers.js';

const integrationEnabled = process.env.INTEGRATION_TEST_ENABLED === 'true';

describe.skipIf(!integrationEnabled)('CLI Compute Services Integration', () => {
  const apiUrl = getOptionalApiUrl();
  let createdServiceId: string | undefined;
  let deletedServiceId: string | undefined;

  afterAll(async () => {
    // Cleanup: delete the test service if it was created
    if (createdServiceId) {
      await runCli(['--json', 'compute', 'delete', createdServiceId], { apiUrl });
    }
  });

  it('compute list --json should return an array', async () => {
    const result = await runCli(['--json', 'compute', 'list'], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout);
    expect(Array.isArray(payload)).toBe(true);
  });

  it('compute create --json should create a service and return it', async () => {
    const result = await runCli([
      '--json', 'compute', 'create',
      '--name', `cli-test-${Date.now()}`,
      '--image', 'nginx:alpine',
      '--port', '80',
      '--cpu', 'shared-1x',
      '--memory', '256',
      '--region', 'iad',
    ], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expectNoErrorPayload(payload);

    expect(payload).toHaveProperty('id');
    expect(payload).toHaveProperty('name');
    expect(payload).toHaveProperty('status');
    expect(payload).toHaveProperty('endpointUrl');
    expect(['running', 'creating', 'deploying']).toContain(payload.status);

    createdServiceId = payload.id as string;
  });

  it('compute get --json should return the created service', async () => {
    expect(createdServiceId).toBeDefined();

    const result = await runCli(['--json', 'compute', 'get', createdServiceId!], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expectNoErrorPayload(payload);

    expect(payload.id).toBe(createdServiceId);
    expect(payload.status).toBe('running');
  });

  it('compute list --json should include the created service', async () => {
    const result = await runCli(['--json', 'compute', 'list'], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout) as Record<string, unknown>[];
    const found = payload.find((s) => s.id === createdServiceId);
    expect(found).toBeDefined();
  });

  it('compute logs --json should return events array', async () => {
    expect(createdServiceId).toBeDefined();

    const result = await runCli(['--json', 'compute', 'logs', createdServiceId!, '--limit', '5'], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout);
    expect(Array.isArray(payload)).toBe(true);
  });

  it('compute stop --json should stop the service', async () => {
    expect(createdServiceId).toBeDefined();

    const result = await runCli(['--json', 'compute', 'stop', createdServiceId!], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expectNoErrorPayload(payload);

    expect(payload.status).toBe('stopped');
  });

  it('compute start --json should start the service', async () => {
    expect(createdServiceId).toBeDefined();

    const result = await runCli(['--json', 'compute', 'start', createdServiceId!], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expectNoErrorPayload(payload);

    expect(payload.status).toBe('running');
  });

  it('compute delete --json should delete the service', async () => {
    expect(createdServiceId).toBeDefined();

    const result = await runCli(['--json', 'compute', 'delete', createdServiceId!], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout) as Record<string, unknown>;
    expect(payload.message).toBe('Service deleted');

    // Mark as cleaned up so afterAll doesn't try again
    deletedServiceId = createdServiceId;
    createdServiceId = undefined;
  });

  it('compute list --json should not contain deleted service', async () => {
    expect(deletedServiceId).toBeDefined();

    const result = await runCli(['--json', 'compute', 'list'], { apiUrl });
    expectCliSuccess(result);

    const payload = parseJsonOutput(result.stdout) as Record<string, unknown>[];
    const found = payload.find((s) => s.id === deletedServiceId);
    expect(found).toBeUndefined();
  });
});
