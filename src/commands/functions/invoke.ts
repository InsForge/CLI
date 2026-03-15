import type { Command } from 'commander';
import { getProjectConfig } from '../../lib/config.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, ProjectNotLinkedError, CLIError } from '../../lib/errors.js';
import { outputJson } from '../../lib/output.js';

export function registerFunctionsInvokeCommand(functionsCmd: Command): void {
  functionsCmd
    .command('invoke <slug>')
    .description('Invoke an edge function')
    .option('--data <json>', 'JSON body to send to the function')
    .option('--method <method>', 'HTTP method (GET, POST, PUT, PATCH, DELETE)', 'POST')
    .action(async (slug: string, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        await requireAuth();

        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();

        const method = opts.method.toUpperCase();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`,
        };

        const fetchOpts: RequestInit = { method, headers };

        if (opts.data && ['POST', 'PUT', 'PATCH'].includes(method)) {
          fetchOpts.body = opts.data;
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
          throw new CLIError(`HTTP ${status}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
