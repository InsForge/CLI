import type { Command } from 'commander';
import { platformFetch } from '../../lib/api/platform.js';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { CLIError, handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig, FAKE_PROJECT_ID } from '../../lib/config.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackDiagnose, shutdownAnalytics } from '../../lib/analytics.js';

interface AdvisorScanSummary {
  scanId: string;
  status: string;
  scanType: string;
  scannedAt: string;
  errorMessage?: string;
  summary: { total: number; critical: number; warning: number; info: number };
  collectorErrors?: { collector: string; error: string; timestamp: string }[];
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
  isResolved?: boolean;
}

interface AdvisorIssuesResponse {
  issues: AdvisorIssue[];
  total: number;
}

/**
 * True when an error from `ossFetch` is a route-level 404 — i.e. this backend
 * is too old to expose the advisor endpoints at all. `ossFetch` throws a
 * `CLIError` carrying the HTTP status for these. A backend that HAS the route
 * but no scan yet returns 200 with a null/empty body, never a 404, so a 404
 * here unambiguously means "route absent → fall back to cloud-backend".
 */
function isOssAdvisorRouteMissing(err: unknown): boolean {
  return err instanceof CLIError && err.statusCode === 404;
}

async function fetchOssAdvisorLatest(): Promise<AdvisorScanSummary | null> {
  const res = await ossFetch('/api/advisor/latest');
  // Guard the parse: no-scan returns null and an empty body would make
  // res.json() throw, matching the .catch pattern used across the codebase.
  return (await res.json().catch(() => null)) as AdvisorScanSummary | null;
}

async function fetchOssAdvisorIssues(params: URLSearchParams): Promise<AdvisorIssuesResponse> {
  const res = await ossFetch(`/api/advisor/issues?${params.toString()}`);
  // The OSS backend returns { issues: [], total: 0 } for the no-scan state, but
  // normalize defensively so a null/empty body can never crash the caller
  // (res.json() throws on an empty body, so guard the parse itself too).
  const data = (await res.json().catch(() => null)) as AdvisorIssuesResponse | null;
  return data ?? { issues: [], total: 0 };
}

async function fetchPlatformAdvisorLatest(
  projectId: string,
  apiUrl?: string,
): Promise<AdvisorScanSummary | null> {
  // 404 here means the legacy cloud-backend has no scan for this project — a
  // normal "no scan yet" state, not a failure. Pass it through and return null.
  const res = await platformFetch(
    `/projects/v1/${projectId}/advisor/latest`,
    { passThroughStatuses: [404] },
    apiUrl,
  );
  if (res.status === 404) return null;
  return (await res.json()) as AdvisorScanSummary;
}

async function fetchPlatformAdvisorIssues(
  projectId: string,
  params: URLSearchParams,
  apiUrl?: string,
): Promise<AdvisorIssuesResponse> {
  const res = await platformFetch(
    `/projects/v1/${projectId}/advisor/latest/issues?${params.toString()}`,
    { passThroughStatuses: [404] },
    apiUrl,
  );
  if (res.status === 404) return { issues: [], total: 0 };
  return (await res.json()) as AdvisorIssuesResponse;
}

/**
 * Scan summary only, used by `diagnose` (no subcommand) to build the
 * aggregate health report.
 *
 * The project's own OSS backend is authoritative — it holds the data and its
 * running version is the only thing that decides whether the advisor route
 * exists. So we always try the OSS advisor first and only fall back to the
 * legacy cloud-backend when the OSS route is absent (backend older than the
 * advisor feature). This avoids trusting possibly-stale Platform metadata.
 * OSS `--api-key` mode has no cloud-backend to fall back to.
 */
export async function fetchAdvisorSummary(
  projectId: string,
  apiUrl?: string,
): Promise<AdvisorScanSummary | null> {
  if (projectId === FAKE_PROJECT_ID) {
    return await fetchOssAdvisorLatest();
  }
  try {
    return await fetchOssAdvisorLatest();
  } catch (err) {
    if (!isOssAdvisorRouteMissing(err)) throw err;
    return await fetchPlatformAdvisorLatest(projectId, apiUrl);
  }
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
        trackDiagnose('advisor', config);

        const projectId = config.project_id;
        const ossMode = projectId === FAKE_PROJECT_ID;

        const issueParams = new URLSearchParams();
        if (opts.severity) issueParams.set('severity', opts.severity);
        if (opts.category) issueParams.set('category', opts.category);
        issueParams.set('limit', opts.limit);

        let scan: AdvisorScanSummary | null;
        let issuesData: AdvisorIssuesResponse;

        // Try the project's own OSS advisor first (it holds the data and its
        // running version is what decides whether the route exists). In
        // Platform mode, fall back to the legacy cloud-backend only when the
        // OSS route is absent (backend older than the advisor feature). OSS
        // `--api-key` mode has no fallback — the oss.ts route-level-404 message
        // guards backends too old to have the route.
        try {
          scan = await fetchOssAdvisorLatest();
          issuesData = await fetchOssAdvisorIssues(issueParams);
        } catch (err) {
          if (ossMode || !isOssAdvisorRouteMissing(err)) throw err;
          scan = await fetchPlatformAdvisorLatest(projectId, apiUrl);
          issuesData = await fetchPlatformAdvisorIssues(projectId, issueParams, apiUrl);
        }

        if (json) {
          outputJson({ scan, issues: issuesData.issues });
        } else {
          if (!scan) {
            console.log('No scan yet.\n');
          } else {
            // Scan summary line
            const date = new Date(scan.scannedAt).toLocaleDateString();
            const s = scan.summary;
            console.log(
              `Scan: ${date} (${scan.status}) — ${s.critical} critical, ${s.warning} warning, ${s.info} info\n`,
            );
          }

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
