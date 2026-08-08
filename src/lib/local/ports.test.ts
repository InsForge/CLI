import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { CLIError } from '../errors.js';
import {
  allocatePorts,
  checkPorts,
  ensurePortsAvailable,
  isPortFree,
  PORT_BLOCK_STEP,
  resolvePorts,
} from './ports.js';
import { DEFAULT_PORTS, type LocalPorts } from './state.js';

const servers: Server[] = [];

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    servers.push(s);
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve());
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A high port unlikely to collide with anything on a dev machine or CI. */
const FREE = 47_921;

describe('isPortFree', () => {
  it('is true for an unbound port', async () => {
    expect(await isPortFree(FREE)).toBe(true);
  });

  it('is false once something is listening', async () => {
    await occupy(FREE);
    expect(await isPortFree(FREE)).toBe(false);
  });
});

describe('resolvePorts', () => {
  it('defaults to the documented ports so existing URLs keep working', () => {
    expect(resolvePorts()).toEqual(DEFAULT_PORTS);
    expect(resolvePorts().app).toBe(7130);
  });

  it('applies only the overrides given', () => {
    expect(resolvePorts({ app: 8130 })).toEqual({ ...DEFAULT_PORTS, app: 8130 });
  });
});

describe('ensurePortsAvailable', () => {
  const ports = (over: Partial<LocalPorts> = {}): LocalPorts => resolvePorts(over);

  it('passes when everything is free', async () => {
    await expect(ensurePortsAvailable(ports({ app: FREE, auth: FREE + 1, deno: FREE + 2, postgres: FREE + 3, postgrest: FREE + 4 }))).resolves.toBeUndefined();
  });

  it('names the occupied port and the override flag', async () => {
    await occupy(FREE);
    const p = ports({ app: FREE, auth: FREE + 1, deno: FREE + 2, postgres: FREE + 3, postgrest: FREE + 4 });
    await expect(ensurePortsAvailable(p)).rejects.toThrow(CLIError);
    await expect(ensurePortsAvailable(p)).rejects.toThrow(String(FREE));
    // The message must say how to fix it, not just that it failed.
    await expect(ensurePortsAvailable(p)).rejects.toThrow('--port-app');
  });

  it('ignores ports the caller knows are its own', async () => {
    await occupy(FREE);
    const p = ports({ app: FREE, auth: FREE + 1, deno: FREE + 2, postgres: FREE + 3, postgrest: FREE + 4 });
    await expect(ensurePortsAvailable(p, new Set([FREE]))).resolves.toBeUndefined();
  });
});

describe('checkPorts', () => {
  it('reports one result per port', async () => {
    const results = await checkPorts(resolvePorts({ app: FREE }));
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.name).sort()).toEqual([
      'app',
      'auth',
      'deno',
      'postgres',
      'postgrest',
    ]);
  });
});

describe('allocatePorts', () => {
  const base = (): LocalPorts =>
    resolvePorts({
      app: FREE,
      auth: FREE + 1,
      deno: FREE + 2,
      postgres: FREE + 3,
      postgrest: FREE + 4,
    });

  it('keeps the defaults when they are free', async () => {
    const { ports: got, moved } = await allocatePorts(base());
    expect(got).toEqual(base());
    expect(moved).toEqual([]);
  });

  it('shifts the whole block when one port is taken', async () => {
    await occupy(FREE + 2);
    const { ports: got, moved } = await allocatePorts(base());
    expect(got.app).toBe(FREE + PORT_BLOCK_STEP);
    expect(got.deno).toBe(FREE + 2 + PORT_BLOCK_STEP);
    // The whole block moves together, so the offset stays legible.
    expect(moved).toHaveLength(5);
  });

  it('keeps shifting past a second occupied block', async () => {
    await occupy(FREE);
    await occupy(FREE + PORT_BLOCK_STEP);
    const { ports: got } = await allocatePorts(base());
    expect(got.app).toBe(FREE + 2 * PORT_BLOCK_STEP);
  });

  it('never moves a port the caller fixed, and says so when it is taken', async () => {
    await occupy(FREE);
    await expect(allocatePorts(base(), new Set(['app']))).rejects.toThrow(CLIError);
    await expect(allocatePorts(base(), new Set(['app']))).rejects.toThrow('--port-app');
  });

  it('shifts the unfixed ports around a fixed one', async () => {
    await occupy(FREE + 1);
    const { ports: got } = await allocatePorts(base(), new Set(['app']));
    expect(got.app).toBe(FREE);
    expect(got.auth).toBe(FREE + 1 + PORT_BLOCK_STEP);
  });

  it('refuses two services on one port', async () => {
    const clashing = { ...base(), auth: FREE };
    await expect(allocatePorts(clashing, new Set(['app', 'auth']))).rejects.toThrow(CLIError);
    await expect(allocatePorts(clashing, new Set(['app', 'auth']))).rejects.toThrow(
      String(FREE),
    );
  });

  it('treats a port the caller owns as available', async () => {
    await occupy(FREE);
    const { ports: got, moved } = await allocatePorts(base(), new Set(), new Set([FREE]));
    expect(got.app).toBe(FREE);
    expect(moved).toEqual([]);
  });
});
