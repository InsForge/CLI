import { CLIError, formatFetchError } from '../errors.js';

/**
 * The InsForge-hosted feedback project (dogfooding: InsForge stores its own
 * product feedback on InsForge). Both values below are public client
 * credentials by design: the anon key can only invoke the submit-feedback
 * edge function — the feedback table is RLS-locked with zero anon policies,
 * and the function enforces validation, per-IP rate limiting, and duplicate
 * folding server-side (see DEVELOPMENT.md §6 for the backend's home).
 *
 * Hardcoded rather than injected from CI secrets so feedback works in every
 * build — local, fork, and release — with no silent no-op failure mode
 * (the POSTHOG_API_KEY lesson from DEVELOPMENT.md). Env overrides exist for
 * testing and emergency rotation.
 */
const FEEDBACK_ENDPOINT =
  process.env.INSFORGE_FEEDBACK_URL ||
  'https://3yzf3pzs.us-east.insforge.app/functions/submit-feedback';
const FEEDBACK_ANON_KEY =
  process.env.INSFORGE_FEEDBACK_ANON_KEY ||
  'anon_d6bd647caa3988037271f3e00661c014c12c3a8be6a01f66c6efa30afe03d0f8';

// Feedback is a side quest — never let a hung endpoint hang the CLI.
const FEEDBACK_TIMEOUT_MS = 10_000;

export interface FeedbackPayload {
  /**
   * The kind of hurdle hit: bug (should work — per contract or docs — but
   * doesn't; docs-vs-behavior discrepancies file here with doc_ref/expected
   * set), feature-request (needed something unsupported), friction (works
   * but confusing/awkward).
   */
  type: 'bug' | 'feature-request' | 'friction' | 'other';
  /** Which part of the InsForge toolkit the issue lives in. */
  component: 'backend' | 'sdk' | 'cli' | 'skills' | 'docs' | 'other';
  severity: 'blocker' | 'major' | 'minor';
  title: string;
  detail: string;
  /** Language/variant for sdk or docs feedback, e.g. js, python, flutter, swift, kotlin, rest-api. */
  language?: string;
  area?: string;
  command?: string;
  error?: string;
  expected?: string;
  /** The alternative the reporter used to get past the hurdle, if any. */
  workaround?: string;
  doc_ref?: string;
  project_id?: string;
  org_id?: string;
  region?: string;
  client_info: {
    source: 'cli';
    cli_version: string;
    node_version: string;
    os: string;
  };
}

export interface FeedbackResult {
  id: string | null;
  /** 'received' for a new report, 'duplicate' when folded into an existing one. */
  status: 'received' | 'duplicate';
}

/**
 * Submit structured product feedback (bug / feature request / friction)
 * to the InsForge team's feedback backend. No login required — the endpoint
 * is public (anon key) so OSS and logged-out users can report too. Free-text
 * fields must already be PII-scrubbed by the caller (see src/lib/redact.ts);
 * the backend re-validates and enforces its own caps.
 */
export async function submitFeedback(payload: FeedbackPayload): Promise<FeedbackResult> {
  let res: Response;
  try {
    res = await fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${FEEDBACK_ANON_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FEEDBACK_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new CLIError(
        `Feedback submission timed out after ${FEEDBACK_TIMEOUT_MS / 1000}s. Try again later.`,
      );
    }
    throw new CLIError(formatFetchError(err, FEEDBACK_ENDPOINT));
  }

  const data = await res.json().catch(() => ({})) as {
    id?: string;
    status?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new CLIError(data.error ?? `Feedback submission failed: ${res.status}`);
  }
  return {
    id: data.id ?? null,
    status: data.status === 'duplicate' ? 'duplicate' : 'received',
  };
}
