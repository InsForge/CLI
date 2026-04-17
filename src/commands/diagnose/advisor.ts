import type { Command } from 'commander';
import { platformFetch } from '../../lib/api/platform.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, CLIError, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig, FAKE_PROJECT_ID } from '../../lib/config.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackDiagnose, shutdownAnalytics } from '../../lib/analytics.js';


interface AdvisorScanSummary {
  scanId: string;
  status: string;
  scanType: string;
  scannedAt: string;
  summary: { total: number; critical: number; warning: number; info: number };
  collectorErrors: { collector: string; error: string; timestamp: string }[];
}

interface AdvisorIssue {
  id: string;
  ruleId: string;
  severity: string;
  category: string;
  title: string;
  description: string;
  affectedObject: string;
  recommendation: string;
  isResolved: boolean;
}

interface AdvisorIssuesResponse {
  issues: AdvisorIssue[];
  total: number;
}

export async function fetchAdvisorSummary(
  projectId: string,
  apiUrl?: string,
): Promise<AdvisorScanSummary> {
  const res = await platformFetch(`/projects/v1/${projectId}/advisor/latest`, {}, apiUrl);
  return (await res.json()) as AdvisorScanSummary;
}

export function registerDiagnoseAdvisorCommand(diagnoseCmd: Command): void {
  diagnoseCmd
    .command('advisor')
    .description('Display latest advisor scan results and issues')
    .option('--severity <level>', 'Filter by severity: critical, warning, info')
    .option('--category <cat>', 'Filter by category: security, performance, health')
    .option('--limit <n>', 'Maximum number of issues to return', '50')
    .action(async (opts, cmd) => {
      const { json, apiUrl } = getRootOpts(cmd);
      try {
        await requireAuth(apiUrl);
        const config = getProjectConfig();
        if (!config) throw new ProjectNotLinkedError();
        if (config.project_id === FAKE_PROJECT_ID) {
          throw new CLIError(
            'Advisor requires InsForge Platform login. Not available when linked via --api-key.',
          );
        }
        trackDiagnose('advisor', config);

        const projectId = config.project_id;

        // Fetch scan summary
        const scanRes = await platformFetch(
          `/projects/v1/${projectId}/advisor/latest`,
          {},
          apiUrl,
        );
        const scan = (await scanRes.json()) as AdvisorScanSummary;

        // Fetch issues
        const issueParams = new URLSearchParams();
        if (opts.severity) issueParams.set('severity', opts.severity);
        if (opts.category) issueParams.set('category', opts.category);
        issueParams.set('limit', opts.limit);

        const issuesRes = await platformFetch(
          `/projects/v1/${projectId}/advisor/latest/issues?${issueParams.toString()}`,
          {},
          apiUrl,
        );
        const issuesData = (await issuesRes.json()) as AdvisorIssuesResponse;

        if (json) {
          outputJson({ scan, issues: issuesData.issues });
        } else {
          // Scan summary line
          const date = new Date(scan.scannedAt).toLocaleDateString();
          const s = scan.summary;
          console.log(
            `Scan: ${date} (${scan.status}) — ${s.critical} critical, ${s.warning} warning, ${s.info} info\n`,
          );

          if (!issuesData.issues || issuesData.issues.length === 0) {
            console.log('No issues found.');
            return;
          }

          const headers = ['Severity', 'Category', 'Affected Object', 'Title'];
          const rows = issuesData.issues.map((issue) => [
            issue.severity,
            issue.category,
            issue.affectedObject,
            issue.title,
          ]);
          outputTable(headers, rows);
        }
        await reportCliUsage('cli.diagnose.advisor', true);
      } catch (err) {
        await reportCliUsage('cli.diagnose.advisor', false);
        await shutdownAnalytics();
        handleError(err, json);
      } finally {
        await shutdownAnalytics();
      }
    });
}
