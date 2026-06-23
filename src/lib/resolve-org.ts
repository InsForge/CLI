import * as prompts from './prompts.js';
import { listOrganizations } from './api/platform.js';
import { getGlobalConfig, getProjectConfig } from './config.js';
import { CLIError } from './errors.js';

/**
 * Resolve the organization to operate on, in priority order:
 *   1. explicit --org-id flag
 *   2. INSFORGE_ORG_ID env var
 *   3. the linked project's org_id (.insforge/project.json)
 *   4. the configured default_org_id
 *   5. auto-select if the account has exactly one org
 *   6. interactive prompt (TTY, non-JSON) — otherwise error
 *
 * Mirrors how `projects list` resolves an org, extended to also honor the
 * linked project so org-scoped commands "just work" inside a project dir.
 */
export async function resolveOrgId(
  flagOrgId: string | undefined,
  json: boolean,
  apiUrl?: string,
): Promise<string> {
  let orgId =
    flagOrgId ??
    process.env.INSFORGE_ORG_ID ??
    getProjectConfig()?.org_id ??
    getGlobalConfig().default_org_id;

  if (orgId) return orgId;

  const orgs = await listOrganizations(apiUrl);
  if (orgs.length === 0) {
    throw new CLIError('No organizations found. Create one with `insforge orgs create`.');
  }
  if (orgs.length === 1) return orgs[0].id;

  if (json) {
    throw new CLIError('Multiple organizations found. Specify --org-id.');
  }

  const selected = await prompts.select<string>({
    message: 'Select an organization:',
    options: orgs.map((o) => ({ value: o.id, label: o.name })),
  });
  if (prompts.isCancel(selected)) process.exit(0);
  orgId = selected;
  return orgId;
}
