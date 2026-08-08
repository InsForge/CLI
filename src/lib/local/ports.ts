/**
 * Port allocation for a local instance.
 *
 * The defaults match every existing InsForge doc (7130 for the API and
 * dashboard, 5432 for Postgres, …), so the first instance on a machine keeps the
 * URLs a user has already seen. A second one cannot have them, and refusing to
 * start would make "one instance per directory" true only for the first
 * directory — so the block shifts by ten until it finds a free set.
 *
 * Shifting the whole block rather than each port separately keeps the offset
 * legible: 7140/7141/7143 is recognisably the second instance, where a per-port
 * scan would land on whatever happened to be free.
 *
 * Two kinds of port never move. An explicit --port-app is an answer, not a
 * preference. A port already in this directory's state belongs to an instance
 * that has data and an .env.local pointing at it; relocating on a restart would
 * strand both.
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
 *
 * One at a time, never Promise.all. 0.0.0.0:P and 127.0.0.1:P overlap, and Linux
 * refuses the second bind while BSD accepts it — so probing them together
 * reported every free port as taken on Linux, and `local start` could not find a
 * port to run on there at all. macOS never showed it.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (!(await bindable(port, '0.0.0.0'))) return false;
  return bindable(port, '127.0.0.1');
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

export const PORT_BLOCK_STEP = 10;
const MAX_BLOCKS = 20;

export interface PortAllocation {
  ports: LocalPorts;
  /** Ports that could not stay at their default, for reporting. */
  moved: { name: keyof LocalPorts; from: number; to: number }[];
}

/**
 * Find a set of free ports, shifting the block by ten at a time.
 *
 * `fixed` names the ports that must be used as given — explicit flags and
 * anything this directory already recorded. When one of those is taken there is
 * nowhere to move it to, so this reports it the same way a single-instance
 * conflict was always reported.
 */
export async function allocatePorts(
  desired: LocalPorts,
  fixed: Set<keyof LocalPorts> = new Set(),
  ignore: Set<number> = new Set(),
): Promise<PortAllocation> {
  const names = Object.keys(desired) as (keyof LocalPorts)[];

  for (let block = 0; block < MAX_BLOCKS; block++) {
    const candidate = {} as LocalPorts;
    for (const name of names) {
      candidate[name] = fixed.has(name)
        ? desired[name]
        : desired[name] + block * PORT_BLOCK_STEP;
    }
    // Two services on one port passes every free check and then fails inside
    // compose with "port is already allocated" — `--port-app 7131` collides with
    // the auth default without either value being wrong on its own.
    const seen = new Map<number, keyof LocalPorts>();
    for (const name of names) {
      const clash = seen.get(candidate[name]);
      if (clash) {
        throw new CLIError(
          `${LABELS[clash]} and ${LABELS[name]} would both use port ${candidate[name]}.\n` +
            'Give one of them a port of its own with --port-' +
            `${clash} or --port-${name}.`,
        );
      }
      seen.set(candidate[name], name);
    }

    const checks = await checkPorts(candidate);
    if (checks.every((c) => c.free || ignore.has(c.port))) {
      const moved = names
        .filter((n) => candidate[n] !== desired[n])
        .map((n) => ({ name: n, from: desired[n], to: candidate[n] }));
      return { ports: candidate, moved };
    }
    // A fixed port is taken, so no offset will help — every block reuses it.
    const stuck = checks.filter((c) => !c.free && !ignore.has(c.port) && fixed.has(c.name));
    if (stuck.length > 0) {
      const detail = stuck.map((c) => `  • ${c.port} (${LABELS[c.name]})`).join('\n');
      const flags = stuck.map((c) => `--port-${c.name} <n>`).join(' ');
      throw new CLIError(
        `Port${stuck.length > 1 ? 's' : ''} already in use:\n${detail}\n\n` +
          'These were set explicitly, or belong to this directory\'s existing\n' +
          'instance, so they were not relocated. Free them, or pick others:\n' +
          `  insforge local start ${flags}`,
      );
    }
  }

  throw new CLIError(
    `No free port block found after trying ${MAX_BLOCKS} of them, starting at ` +
      `${desired.app}. Something is occupying a very wide range; pass ports ` +
      'explicitly with --port-app and friends.',
  );
}
