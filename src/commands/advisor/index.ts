import type { Command } from 'commander';
import {
  triggerAdvisorScan,
  listAdvisorSuppressions,
  createAdvisorSuppression,
  deleteAdvisorSuppression,
} from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { CLIError, handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable, outputSuccess, outputInfo } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';
import { ADVISOR_SUPPRESSION_REASONS } from '../../types.js';
import type { AdvisorSuppressionReason, AdvisorSuppressionScope } from '../../types.js';

function assertReason(reason: string | undefined): AdvisorSuppressionReason {
  if (!reason) {
    throw new CLIError(
      `Missing --reason. Valid reasons: ${ADVISOR_SUPPRESSION_REASONS.join(', ')}.`,
    );
  }
  if (!(ADVISOR_SUPPRESSION_REASONS as readonly string[]).includes(reason)) {
    throw new CLIError(
      `Invalid --reason "${reason}". Valid reasons: ${ADVISOR_SUPPRESSION_REASONS.join(', ')}.`,
    );
  }
  return reason as AdvisorSuppressionReason;
}

export function registerAdvisorCommands(advisorCmd: Command): void {
  advisorCmd
    .command('scan')
    .description('Trigger an advisor scan now (instead of waiting for the schedule)')
    .action(async (_opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const result = await triggerAdvisorScan();
        await trackCommandUsage('advisor', 'scan', true);
        if (json) {
          outputJson(result);
        } else {
          outputSuccess(
            `Advisor scan started (${result.scanId}). View results with \`insforge diagnose advisor\`.`,
          );
        }
      } catch (err) {
        await trackCommandUsage('advisor', 'scan', false, {}, err);
        handleError(err, json);
      }
    });

  advisorCmd
    .command('suppressions')
    .description('List suppressed advisor findings')
    .action(async (_opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const suppressions = await listAdvisorSuppressions();
        await trackCommandUsage('advisor', 'suppressions', true, {
          result_count: suppressions.length,
        });
        if (json) {
          outputJson(suppressions);
        } else if (!suppressions.length) {
          outputInfo('No suppressions found.');
        } else {
          outputTable(
            ['ID', 'Rule', 'Scope', 'Affected Object', 'Reason', 'Created'],
            suppressions.map((s) => [
              s.id,
              s.ruleId,
              s.scope,
              s.affectedObject ?? '-',
              s.reason,
              new Date(s.createdAt).toLocaleDateString(),
            ]),
          );
        }
      } catch (err) {
        await trackCommandUsage('advisor', 'suppressions', false, {}, err);
        handleError(err, json);
      }
    });

  advisorCmd
    .command('suppress <ruleId>')
    .description('Suppress an advisor finding (dismiss a false positive with a recorded reason)')
    .option(
      '--object <affectedObject>',
      'Suppress only the finding for this affected object (default: the whole rule)',
    )
    .option('--reason <reason>', `Why it is suppressed (${ADVISOR_SUPPRESSION_REASONS.join(' | ')})`)
    .option('--note <note>', 'Free-form note (required when --reason is "other")')
    .action(async (ruleId: string, opts: { object?: string; reason?: string; note?: string }, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const reason = assertReason(opts.reason);
        // The backend matches affectedObject verbatim against scan findings,
        // so pass it through untrimmed — but a blank value is always a mistake.
        if (opts.object !== undefined && opts.object.trim() === '') {
          throw new CLIError('--object cannot be empty. Pass the finding\'s Affected Object exactly, or omit --object to suppress the whole rule.');
        }
        const note = opts.note?.trim();
        if (reason === 'other' && !note) {
          throw new CLIError('--note is required when --reason is "other".');
        }
        const scope: AdvisorSuppressionScope = opts.object !== undefined ? 'instance' : 'rule';
        const suppression = await createAdvisorSuppression({
          ruleId,
          scope,
          ...(opts.object !== undefined ? { affectedObject: opts.object } : {}),
          reason,
          ...(note ? { note } : {}),
        });
        await trackCommandUsage('advisor', 'suppress', true, { scope, reason });
        if (json) {
          outputJson(suppression);
        } else {
          const target = scope === 'instance' ? `"${ruleId}" on ${opts.object}` : `rule "${ruleId}"`;
          outputSuccess(
            `Suppressed ${target} (${suppression.id}). Undo with \`insforge advisor unsuppress ${suppression.id}\`.`,
          );
        }
      } catch (err) {
        await trackCommandUsage('advisor', 'suppress', false, {}, err);
        handleError(err, json);
      }
    });

  advisorCmd
    .command('unsuppress <suppressionId>')
    .description('Remove a suppression so the finding shows up again')
    .action(async (suppressionId: string, _opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        await deleteAdvisorSuppression(suppressionId);
        await trackCommandUsage('advisor', 'unsuppress', true);
        if (json) {
          outputJson({ deleted: true, suppression_id: suppressionId });
        } else {
          outputSuccess(`Suppression ${suppressionId} removed. The finding will reappear on the next scan.`);
        }
      } catch (err) {
        await trackCommandUsage('advisor', 'unsuppress', false, {}, err);
        handleError(err, json);
      }
    });
}
