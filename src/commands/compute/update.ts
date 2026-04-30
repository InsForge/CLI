import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';

const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;

// Commander collector for repeatable flags. Each invocation appends to the
// running list rather than overwriting.
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

// Parse a "KEY=VALUE" string into a tuple, validating the key shape against
// the same regex the OSS schema enforces. Values may contain '=' and are
// preserved verbatim — only the first '=' separates key from value.
function parseKeyValue(raw: string): [string, string] {
  const eq = raw.indexOf('=');
  if (eq <= 0) {
    throw new CLIError(
      `Invalid --env-set "${raw}": expected KEY=VALUE (key first, then '=', then value)`
    );
  }
  const key = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if (!ENV_KEY_REGEX.test(key)) {
    throw new CLIError(`Invalid env var key "${key}": must match [A-Z_][A-Z0-9_]*`);
  }
  return [key, value];
}

function assertValidKey(key: string): void {
  if (!ENV_KEY_REGEX.test(key)) {
    throw new CLIError(`Invalid env var key "${key}": must match [A-Z_][A-Z0-9_]*`);
  }
}

export function registerComputeUpdateCommand(computeCmd: Command): void {
  computeCmd
    .command('update <id>')
    .description('Update a compute service')
    .option('--image <image>', 'Docker image URL')
    .option('--port <port>', 'Container port')
    .option('--cpu <tier>', 'CPU tier')
    .option('--memory <mb>', 'Memory in MB')
    .option('--region <region>', 'Fly.io region')
    .option(
      '--env <json>',
      'Replace ALL env vars with this JSON object. To rotate one secret without restating the others, use --env-set instead.'
    )
    .option(
      '--env-set <KEY=VALUE>',
      'Set or update one env var (repeatable). Merges with existing — does not clear other vars.',
      collect,
      []
    )
    .option(
      '--env-unset <KEY>',
      'Remove one env var (repeatable). Merges with existing — leaves other vars in place.',
      collect,
      []
    )
    .action(async (id: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const body: Record<string, unknown> = {};
        if (opts.image) body.imageUrl = opts.image;
        if (opts.port) {
          if (!Number.isFinite(Number(opts.port))) {
            throw new CLIError('Invalid value for --port: must be a number');
          }
          body.port = Number(opts.port);
        }
        if (opts.cpu) body.cpu = opts.cpu;
        if (opts.memory) {
          if (!Number.isFinite(Number(opts.memory))) {
            throw new CLIError('Invalid value for --memory: must be a number');
          }
          body.memory = Number(opts.memory);
        }
        if (opts.region) body.region = opts.region;

        const envSetArgs = opts.envSet as string[];
        const envUnsetArgs = opts.envUnset as string[];
        const hasPatch = envSetArgs.length > 0 || envUnsetArgs.length > 0;

        if (opts.env && hasPatch) {
          throw new CLIError(
            '--env (wholesale replace) and --env-set/--env-unset (partial merge) are mutually exclusive — pick one.'
          );
        }

        if (opts.env) {
          try {
            body.envVars = JSON.parse(opts.env);
          } catch {
            throw new CLIError('Invalid JSON for --env');
          }
        }

        if (hasPatch) {
          const setMap: Record<string, string> = {};
          for (const arg of envSetArgs) {
            const [k, v] = parseKeyValue(arg);
            setMap[k] = v;
          }
          for (const k of envUnsetArgs) assertValidKey(k);
          body.envVarsPatch = {
            ...(envSetArgs.length > 0 && { set: setMap }),
            ...(envUnsetArgs.length > 0 && { unset: envUnsetArgs }),
          };
        }

        if (Object.keys(body).length === 0) {
          throw new CLIError(
            'No update fields provided. Use --image, --port, --cpu, --memory, --region, --env, --env-set, or --env-unset.'
          );
        }

        const res = await ossFetch(`/api/compute/services/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        const service = await res.json() as Record<string, unknown>;

        if (json) {
          outputJson(service);
        } else {
          outputSuccess(`Service "${service.name}" updated [${service.status}]`);
        }
        await reportCliUsage('cli.compute.update', true);
      } catch (err) {
        await reportCliUsage('cli.compute.update', false);
        handleError(err, json);
      }
    });
}
