import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { getProjectConfig } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, ProjectNotLinkedError, CLIError } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

// Shells like PowerShell can strip or mangle embedded double quotes in a
// --data '{"key":"value"}' argument before it ever reaches process.argv, so
// a malformed body here is often a quoting problem, not a typo. Validate
// client-side with a hint instead of letting the server reject the body.
const JSON_QUOTING_HINT =
  'Invalid JSON in --data. On PowerShell, use --data \'{\\"key\\":\\"value\\"}\' ' +
  '(escaped inner quotes) or pass --data-file <path.json> instead.';

export function registerFunctionsInvokeCommand(functionsCmd: Command): void {
  functionsCmd
    .command('invoke <slug>')
    .description('Invoke an edge function')
    .option('--data <json>', 'JSON body to send to the function')
    .option(
      '--data-file <path>',
      'Path to a JSON file to send as the body. Mutually exclusive with --data.'
    )
    .option('--method <method>', 'HTTP method (GET, POST, PUT, PATCH, DELETE)', 'POST')
    .action(async (slug: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();

        if (opts.data && opts.dataFile) {
          throw new CLIError(
            '--data and --data-file are mutually exclusive — pick one source for the body.'
          );
        }

        const method = opts.method.toUpperCase();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`,
        };

        const fetchOpts: RequestInit = { method, headers };

        if ((opts.data || opts.dataFile) && ['POST', 'PUT', 'PATCH'].includes(method)) {
          let body: string;
          if (opts.dataFile) {
            try {
              body = readFileSync(resolve(opts.dataFile), 'utf-8');
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new CLIError(`Could not read --data-file at ${opts.dataFile}: ${msg}`);
            }
          } else {
            body = opts.data;
          }

          try {
            JSON.parse(body);
          } catch {
            throw new CLIError(JSON_QUOTING_HINT);
          }

          fetchOpts.body = body;
        }

        // Functions client endpoint is at /functions/{slug} (not /api/functions/{slug})
        // Use direct fetch so we always show the function's full response,
        // even on non-200 status codes (function errors are part of the output).
        const res = await fetch(
          `${config.oss_host}/functions/${encodeURIComponent(slug)}`,
          fetchOpts,
        );

        const contentType = res.headers.get('content-type') ?? '';
        const status = res.status;

        if (status < 400) {
          await trackCommandUsage('functions', 'invoke', true);
        }

        if (contentType.includes('application/json')) {
          const data = await res.json();
          if (json) {
            outputJson({ status, body: data });
          } else {
            console.log(JSON.stringify(data, null, 2));
          }
        } else {
          const text = await res.text();
          console.log(text);
        }

        // Exit with non-zero code on function errors
        if (status >= 400) {
          throw new CLIError(`HTTP ${status}`, 1, 'HTTP_ERROR');
        }
      } catch (err) {
        await trackCommandUsage('functions', 'invoke', false, {}, err);
        handleError(err, json);
      }
    });
}
