import type { Command } from 'commander';
import { listOrganizations, listProjects } from '../lib/api/platform.js';
import { requireAuth } from '../lib/credentials.js';
import { handleError, getRootOpts } from '../lib/errors.js';
import { outputJson, outputTable } from '../lib/output.js';
import { trackTopLevelUsage } from '../lib/command-telemetry.js';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List all organizations and their projects')
    .action(async (_opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgs = await listOrganizations(apiUrl);

        await trackTopLevelUsage('list', true, { result_count: orgs.length });

        if (orgs.length === 0) {
          if (json) {
            outputJson([]);
          } else {
            console.log('No organizations found.');
          }
          return;
        }

        // Fetch projects for all orgs in parallel
        const orgProjects = await Promise.all(
          orgs.map(async (org) => ({
            org,
            projects: await listProjects(org.id, apiUrl),
          })),
        );

        if (json) {
          outputJson(
            orgProjects.map(({ org, projects }) => ({
              id: org.id,
              name: org.name,
              type: org.type ?? null,
              projects: projects.map((p) => ({
                id: p.id,
                name: p.name,
                region: p.region,
                status: p.status,
                appkey: p.appkey,
              })),
            })),
          );
          return;
        }

        // Human-readable: grouped table
        const rows: string[][] = [];
        for (const { org, projects } of orgProjects) {
          if (projects.length === 0) {
            rows.push([org.name, '-', '-', '-', '-']);
          } else {
            for (let i = 0; i < projects.length; i++) {
              const p = projects[i];
              rows.push([
                i === 0 ? org.name : '',
                p.name,
                p.region,
                p.status,
                p.appkey,
              ]);
            }
          }
        }

        outputTable(['Organization', 'Project', 'Region', 'Status', 'AppKey'], rows);
      } catch (err) {
        await trackTopLevelUsage('list', false, {}, err);
        handleError(err, json);
      }
    });
}
