import type { Command } from 'commander';
import { platformFetch, getProject } from '../../lib/api/platform.js';
import { ossFetch } from '../../lib/api/oss.js';
import { requireAuth } from '../../lib/credentials.js';
import { handleError, getRootOpts, ProjectNotLinkedError } from '../../lib/errors.js';
import { getProjectConfig, FAKE_PROJECT_ID } from '../../lib/config.js';
import { outputJson, outputTable } from '../../lib/output.js';
import { reportCliUsage } from '../../lib/skills.js';
import { trackDiagnose, shutdownAnalytics } from '../../lib/analytics.js';

// First InsForge OSS backend release that serves the advisor endpoints
// (`/api/advisor/latest`, `/api/advisor/issues`). Projects on older backends
// have no OSS advisor route, so we read their data from cloud-backend instead.
const OSS_ADVISOR_MIN_VERSION = '2.2.7';

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
 * Parse a "MAJOR.MINOR.PATCH" version into a numeric tuple, tolerating a
 * leading `v` and trailing pre-release/build suffixes. Missing/non-numeric
 * segments become 0.
 */
function parseSemver(version: string): [number, number, number] {
  const cleaned = version.trim().replace(/^v/i, '');
  const [major, minor, patch] = cleaned
    .split('.')
    .map((part) => parseInt(part, 10));
  return [
    Number.isFinite(major) ? major : 0,
    Number.isFinite(minor) ? minor : 0,
    Number.isFinite(patch) ? patch : 0,
  ];
}

/** True when `version` is >= `min`, compared numerically per segment. */
function isVersionGte(version: string, min: string): boolean {
  const a = parseSemver(version);
  const b = parseSemver(min);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/**
 * In Platform mode, decide whether the project's own OSS backend is new enough
 * to serve the advisor endpoints itself, based on the Platform-tracked
 * `service_version` (the authoritative version; same source manage.ts and
 * update-version use). A Platform hiccup / null version degrades to `false`
 * (→ cloud-backend legacy path) rather than erroring.
 */
async function platformProjectServesAdvisor(projectId: string, apiUrl?: string): Promise<boolean> {
  const project = await getProject(projectId, apiUrl).catch(() => null);
  const version = project?.service_version;
  if (!version) return false;
  return isVersionGte(version, OSS_ADVISOR_MIN_VERSION);
}

async function fetchOssAdvisorLatest(): Promise<AdvisorScanSummary | null> {
  const res = await ossFetch('/api/advisor/latest');
  return (await res.json()) as AdvisorScanSummary | null;
}

async function fetchOssAdvisorIssues(params: URLSearchParams): Promise<AdvisorIssuesResponse> {
  const res = await ossFetch(`/api/advisor/issues?${params.toString()}`);
  return (await res.json()) as AdvisorIssuesResponse;
}

async function fetchPlatformAdvisorLatest(
  projectId: string,
  apiUrl?: string,
): Promise<AdvisorScanSummary> {
  const res = await platformFetch(`/projects/v1/${projectId}/advisor/latest`, {}, apiUrl);
  return (await res.json()) as AdvisorScanSummary;
}

async function fetchPlatformAdvisorIssues(
  projectId: string,
  params: URLSearchParams,
  apiUrl?: string,
): Promise<AdvisorIssuesResponse> {
  const res = await platformFetch(
    `/projects/v1/${projectId}/advisor/latest/issues?${params.toString()}`,
    {},
    apiUrl,
  );
  return (await res.json()) as AdvisorIssuesResponse;
}

/**
 * Scan summary only, used by `diagnose` (no subcommand) to build the
 * aggregate health report.
 *
 * OSS `--api-key` mode: read the project's own OSS advisor directly (only
 * source; the oss.ts route-level-404 message guards old backends).
 * Platform mode: gate on the Platform-tracked `service_version` — >= 2.2.7
 * uses the project's OSS advisor, otherwise the cloud-backend legacy path.
 */
export async function fetchAdvisorSummary(
  projectId: string,
  apiUrl?: string,
): Promise<AdvisorScanSummary | null> {
  if (projectId === FAKE_PROJECT_ID) {
    return await fetchOssAdvisorLatest();
  }
  if (await platformProjectServesAdvisor(projectId, apiUrl)) {
    return await fetchOssAdvisorLatest();
  }
  return await fetchPlatformAdvisorLatest(projectId, apiUrl);
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

        // Version gate. OSS `--api-key` mode: no Platform project to query, so
        // hit the project's own OSS advisor directly — the oss.ts
        // route-level-404 message guards backends too old to have the route.
        // Platform mode: route by the Platform-tracked `service_version` —
        // >= OSS_ADVISOR_MIN_VERSION uses the project's OSS advisor, older
        // projects read from cloud-backend (which still holds their data).
        if (ossMode || (await platformProjectServesAdvisor(projectId, apiUrl))) {
          scan = await fetchOssAdvisorLatest();
          issuesData = await fetchOssAdvisorIssues(issueParams);
        } else {
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
