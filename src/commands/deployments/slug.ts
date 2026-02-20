import type { Command } from 'commander';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { getProjectConfig } from '../../lib/config.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { outputJson, outputSuccess } from '../../lib/output.js';

export function registerDeploymentsSlugCommand(deploymentsCmd: Command): void {
  deploymentsCmd
    .command('slug [slug]')
    .description('Set or remove the custom slug for the deployed site')
    .option('--remove', 'Remove the custom slug')
    .action(async (slug: string | undefined, opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        requireAuth();
        if (!getProjectConfig()) throw new ProjectNotLinkedError();

        const slugValue = opts.remove ? null : (slug ?? null);

        if (!opts.remove && !slug) {
          // No slug provided and not removing — show current metadata instead
          const res = await ossFetch('/api/deployments/metadata');
          const d = await res.json() as Record<string, unknown>;
          if (json) {
            outputJson(d);
          } else {
            console.log(`Current slug: ${d.slug ?? '(none)'}`);
            if (d.domain) console.log(`Domain: ${d.domain}`);
          }
          return;
        }

        const res = await ossFetch('/api/deployments/slug', {
          method: 'PUT',
          body: JSON.stringify({ slug: slugValue }),
        });
        const result = await res.json() as { success: boolean; slug: string | null; domain: string | null };

        if (json) {
          outputJson(result);
        } else {
          if (result.slug) {
            outputSuccess(`Slug set to "${result.slug}"`);
            if (result.domain) console.log(`  Domain: ${result.domain}`);
          } else {
            outputSuccess('Custom slug removed.');
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
