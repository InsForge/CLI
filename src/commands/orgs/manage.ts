import type { Command } from 'commander';
import * as clack from '@clack/prompts';
import {
  createOrganization,
  updateOrganization,
  listMembers,
  inviteMember,
  removeMember,
  updateMemberRole,
} from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError } from '../../lib/errors.js';
import { resolveOrgId } from '../../lib/resolve-org.js';
import { outputJson, outputTable, outputSuccess, outputInfo } from '../../lib/output.js';
import type { MemberRole } from '../../types.js';

const ORG_TYPES = ['personal', 'team', 'company'];
const MEMBER_ROLES: MemberRole[] = ['administrator', 'developer'];

function assertRole(role: string): MemberRole {
  if (!MEMBER_ROLES.includes(role as MemberRole)) {
    throw new CLIError(`Invalid role "${role}". Valid roles: ${MEMBER_ROLES.join(', ')}.`);
  }
  return role as MemberRole;
}

export function registerOrgsManageCommands(orgsCmd: Command): void {
  orgsCmd
    .command('create <name>')
    .description('Create a new organization')
    .option('--type <type>', `Organization type (${ORG_TYPES.join(' | ')})`, 'team')
    .action(async (name: string, opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        if (!ORG_TYPES.includes(opts.type)) {
          throw new CLIError(`Invalid --type "${opts.type}". Valid types: ${ORG_TYPES.join(', ')}.`);
        }
        const org = await createOrganization({ name, type: opts.type }, apiUrl);
        if (json) {
          outputJson(org);
        } else {
          outputSuccess(`Organization "${org.name}" created (${org.id}).`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  orgsCmd
    .command('update')
    .description('Update an organization (name and/or type)')
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .option('--name <name>', 'New organization name (min 2 characters)')
    .option('--type <type>', `Organization type (${ORG_TYPES.join(' | ')})`)
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);

        const body: { name?: string; type?: string } = {};
        if (opts.name) body.name = opts.name;
        if (opts.type) {
          if (!ORG_TYPES.includes(opts.type)) {
            throw new CLIError(`Invalid --type "${opts.type}". Valid types: ${ORG_TYPES.join(', ')}.`);
          }
          body.type = opts.type;
        }
        if (Object.keys(body).length === 0) {
          throw new CLIError('Nothing to update. Pass --name and/or --type.');
        }

        const org = await updateOrganization(orgId, body, apiUrl);
        if (json) {
          outputJson(org);
        } else {
          outputSuccess(`Organization "${org.name}" updated.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  const membersCmd = orgsCmd.command('members').description('Manage organization members');

  membersCmd
    .command('list')
    .description('List members and pending invitations')
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const { members, invitations } = await listMembers(orgId, apiUrl);

        if (json) {
          outputJson({ members, invitations });
          return;
        }
        if (!members.length) {
          outputInfo('No members found.');
        } else {
          outputTable(
            ['Member ID', 'Name', 'Email', 'Role'],
            members.map((m) => [m.id, m.name ?? '-', m.email ?? '-', m.role]),
          );
        }
        const pending = invitations.filter((i) => i.status === 'pending');
        if (pending.length) {
          outputInfo('\nPending invitations:');
          outputTable(
            ['Email', 'Role', 'Expires'],
            pending.map((i) => [i.email, i.role, new Date(i.expires_at).toLocaleDateString()]),
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  membersCmd
    .command('invite <email>')
    .description('Invite a member by email')
    .option('--role <role>', `Member role (${MEMBER_ROLES.join(' | ')})`, 'developer')
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (email: string, opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const role = assertRole(opts.role);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const invitation = await inviteMember(orgId, email, role, apiUrl);
        if (json) {
          outputJson(invitation);
        } else {
          outputSuccess(`Invited ${email} as ${invitation.role}.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  membersCmd
    .command('remove <memberId>')
    .description('Remove a member from the organization')
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (memberId: string, opts, cmd) => {
      const { json, apiUrl, yes } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);

        if (!yes && !json) {
          const confirmed = await clack.confirm({
            message: `Remove member ${memberId} from the organization?`,
          });
          if (clack.isCancel(confirmed) || !confirmed) {
            outputInfo('Cancelled.');
            return;
          }
        }

        await removeMember(orgId, memberId, apiUrl);
        if (json) {
          outputJson({ removed: true, member_id: memberId });
        } else {
          outputSuccess(`Member ${memberId} removed.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  membersCmd
    .command('role <memberId> <role>')
    .description(`Change a member's role (${MEMBER_ROLES.join(' | ')})`)
    .option('--org-id <id>', 'Organization ID (defaults to linked project / default org)')
    .action(async (memberId: string, role: string, opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const validRole = assertRole(role);
        const orgId = await resolveOrgId(opts.orgId, json, apiUrl);
        const member = await updateMemberRole(orgId, memberId, validRole, apiUrl);
        if (json) {
          outputJson(member);
        } else {
          outputSuccess(`Member ${memberId} is now ${member.role}.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
