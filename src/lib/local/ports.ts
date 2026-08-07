/**
 * Port availability for a local instance.
 *
 * The defaults match every existing InsForge doc (7130 for the API and
 * dashboard, 5432 for Postgres, …), so URLs a user has already seen keep
 * working. When one is taken we report exactly which and stop, rather than
 * silently relocating the instance to ports nothing else knows about.
 */

import { createServer } from 'node:net';
import { CLIError } from '../errors.js';
import { DEFAULT_PORTS, type LocalPorts } from './state.js';

export function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Free means bindable on both the wildcard address and loopback.
 *
 * Checking only loopback misses the collisions that matter most here. Docker
 * publishes on 0.0.0.0, and on macOS a container holding 0.0.0.0:5432 still
 * leaves a Node bind to 127.0.0.1:5432 succeeding — so a second InsForge
 * instance passed this check and then died in `docker compose up` with "port is
 * already allocated". Checking only the wildcard would miss a service bound to
 * loopback alone, which a container publish would also collide with.
 */
export async function isPortFree(port: number): Promise<boolean> {
  const [wildcard, loopback] = await Promise.all([
    bindable(port, '0.0.0.0'),
    bindable(port, '127.0.0.1'),
  ]);
  return wildcard && loopback;
}

export interface PortCheck {
  name: keyof LocalPorts;
  port: number;
  free: boolean;
}

export async function checkPorts(ports: LocalPorts): Promise<PortCheck[]> {
  const entries = Object.entries(ports) as [keyof LocalPorts, number][];
  return Promise.all(
    entries.map(async ([name, port]) => ({ name, port, free: await isPortFree(port) })),
  );
}

const LABELS: Record<keyof LocalPorts, string> = {
  app: 'API + dashboard',
  auth: 'auth service',
  deno: 'edge functions runtime',
  postgres: 'Postgres',
  postgrest: 'PostgREST',
};

/**
 * Throw with the occupied ports named and the override spelled out. Ports
 * already bound by THIS instance's own containers are expected during a restart
 * and are passed in via `ignore`.
 */
export async function ensurePortsAvailable(
  ports: LocalPorts,
  ignore: Set<number> = new Set(),
): Promise<void> {
  const checks = await checkPorts(ports);
  const taken = checks.filter((c) => !c.free && !ignore.has(c.port));
  if (taken.length === 0) return;

  const detail = taken.map((c) => `  • ${c.port} (${LABELS[c.name]})`).join('\n');
  const flags = taken.map((c) => `--port-${c.name} <n>`).join(' ');
  throw new CLIError(
    `Port${taken.length > 1 ? 's' : ''} already in use:\n${detail}\n\n` +
      'Another InsForge instance or an unrelated service is bound there. Either\n' +
      `stop it, or pick different ports: insforge local start ${flags}`,
  );
}

export function resolvePorts(overrides: Partial<LocalPorts> = {}): LocalPorts {
  return { ...DEFAULT_PORTS, ...overrides };
}
