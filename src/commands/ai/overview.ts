import type { Command } from 'commander';
import { getAiOverview } from '../../lib/api/ai.js';
import { handleError, getRootOpts } from '../../lib/errors.js';
import { outputJson, outputTable, outputInfo } from '../../lib/output.js';
import { trackCommandUsage } from '../../lib/command-telemetry.js';

/** OpenRouter usage/limit figures are USD credit amounts. */
function usd(n: number | null): string {
  if (n === null) return 'unlimited';
  return `$${n.toFixed(2)}`;
}

export function registerAiOverviewCommand(aiCmd: Command): void {
  aiCmd
    .command('overview')
    .description('Show Model Gateway key usage: total spend, limit, and remaining credit')
    .action(async (_opts, cmd) => {
      const { json } = getRootOpts(cmd);
      try {
        const overview = await getAiOverview();
        await trackCommandUsage('ai', 'overview', true);

        if (json) {
          outputJson(overview);
          return;
        }

        const k = overview.key;
        if (k.label) outputInfo(`Key:              ${k.label}`);
        outputInfo(`Usage (total):    ${usd(k.usage)}`);
        outputInfo(`Limit:            ${usd(k.limit)}`);
        outputInfo(`Remaining:        ${usd(k.limitRemaining)}`);
        if (k.limitReset) outputInfo(`Limit resets:     ${k.limitReset}`);
        outputInfo(`Usage today:      ${usd(k.usageDaily)}`);
        outputInfo(`Usage this week:  ${usd(k.usageWeekly)}`);
        outputInfo(`Usage this month: ${usd(k.usageMonthly)}`);
        if (k.isFreeTier) outputInfo('Tier:             free');

        if (overview.modelUsage && overview.modelUsage.length > 0) {
          outputInfo('');
          outputTable(
            ['Model', 'Requests', 'Tokens', 'Spend'],
            overview.modelUsage.map((m) => [
              m.model,
              String(m.requests),
              String(m.totalTokens),
              usd(m.spend),
            ]),
          );
        } else if (!k.observabilityAvailable && k.observabilityError) {
          outputInfo(`\nPer-model activity unavailable: ${k.observabilityError}`);
        } else if (k.observabilityAvailable) {
          outputInfo('\nNo per-model activity yet.');
        }
      } catch (err) {
        await trackCommandUsage('ai', 'overview', false, {}, err);
        handleError(err, json);
      }
    });
}
