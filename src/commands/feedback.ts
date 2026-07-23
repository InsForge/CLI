import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as prompts from '../lib/prompts.js';
import { submitFeedback, type FeedbackPayload } from '../lib/api/feedback.js';
import { getProjectConfig, FAKE_PROJECT_ID } from '../lib/config.js';
import { trackTopLevelUsage } from '../lib/command-telemetry.js';
import { CLIError, handleError, getRootOpts } from '../lib/errors.js';
import { outputJson, outputSuccess, outputInfo } from '../lib/output.js';
import { redactSensitive, truncateMiddle } from '../lib/redact.js';

const TYPES = ['bug', 'feature-request', 'friction', 'other'] as const;
const COMPONENTS = ['backend', 'sdk', 'cli', 'skills', 'docs', 'other'] as const;
const SEVERITIES = ['blocker', 'major', 'minor'] as const;
type FeedbackType = (typeof TYPES)[number];
type FeedbackComponent = (typeof COMPONENTS)[number];
type FeedbackSeverity = (typeof SEVERITIES)[number];

// Per-field caps keep reports triage-able: enough room for a real repro,
// not enough for a full log dump. Long error output is truncated head+tail.
const LIMITS = {
  title: 200,
  detail: 4000,
  error: 2000,
  expected: 1000,
  command: 500,
  workaround: 1000,
  doc: 300,
  area: 100,
  language: 40,
} as const;

interface FeedbackOpts {
  type?: string;
  component?: string;
  language?: string;
  title?: string;
  detail?: string;
  file?: string;
  area?: string;
  command?: string;
  error?: string;
  expected?: string;
  workaround?: string;
  doc?: string;
  severity: string;
}

/** Redact PII/credentials first, then cap length — redacting after truncation
 *  could leave a half-visible token fragment at the cut point. */
function clean(text: string, max: number): string {
  return truncateMiddle(redactSensitive(text.trim()), max);
}

function cleanOptional(text: string | undefined, max: number): string | undefined {
  const out = text ? clean(text, max) : undefined;
  return out || undefined;
}

interface RequiredFields {
  type?: string;
  component?: string;
  language?: string;
  title?: string;
  detail?: string;
}

async function promptMissing(fields: RequiredFields): Promise<RequiredFields> {
  let { type, component, language, title, detail } = fields;

  if (!type) {
    const picked = await prompts.select<FeedbackType>({
      message: 'What kind of hurdle did you hit?',
      options: [
        { value: 'bug', label: 'Bug', hint: 'it should work — per contract or docs — but it does not' },
        { value: 'feature-request', label: 'Feature request', hint: 'what I needed is not supported' },
        { value: 'friction', label: 'Friction', hint: 'works, but confusing or awkward (bad error, forced detour)' },
        { value: 'other', label: 'Other' },
      ],
    });
    if (prompts.isCancel(picked)) throw new CLIError('Feedback cancelled.');
    type = picked;
  }

  if (!component) {
    const picked = await prompts.select<FeedbackComponent>({
      message: 'Where in the InsForge toolkit is the issue?',
      options: [
        { value: 'backend', label: 'Backend', hint: 'the InsForge platform / hosted services' },
        { value: 'sdk', label: 'SDK', hint: '@insforge/sdk or another language SDK' },
        { value: 'cli', label: 'CLI', hint: '@insforge/cli itself' },
        { value: 'skills', label: 'Agent skills', hint: 'insforge / insforge-cli skill content' },
        { value: 'docs', label: 'Docs', hint: 'documentation site or `docs` command content' },
        { value: 'other', label: 'Other' },
      ],
    });
    if (prompts.isCancel(picked)) throw new CLIError('Feedback cancelled.');
    component = picked;
  }

  if (component === 'sdk' && !language) {
    const entered = await prompts.text({
      message: 'Which SDK language? (js, python, flutter, swift, kotlin, …)',
      validate: (v) => (v.trim() ? undefined : 'A language is required for SDK feedback'),
    });
    if (prompts.isCancel(entered)) throw new CLIError('Feedback cancelled.');
    language = entered;
  }

  if (!title) {
    const entered = await prompts.text({
      message: 'One-line summary of the issue',
      validate: (v) => (v.trim() ? undefined : 'A summary is required'),
    });
    if (prompts.isCancel(entered)) throw new CLIError('Feedback cancelled.');
    title = entered;
  }

  if (!detail) {
    const entered = await prompts.text({
      message: 'What happened, and what did you expect?',
      validate: (v) => (v.trim() ? undefined : 'Details are required'),
    });
    if (prompts.isCancel(entered)) throw new CLIError('Feedback cancelled.');
    detail = entered;
  }

  return { type, component, language, title, detail };
}

export function registerFeedbackCommand(program: Command): void {
  program
    .command('feedback')
    .description(
      'Report an InsForge-side hurdle — a bug (including docs-vs-behavior discrepancies), a missing ' +
      'capability, or DX friction — to the InsForge team. For agents: use this whenever any part of ' +
      'the InsForge toolkit (backend, an SDK, the CLI, agent skills, docs) got in your way — not the ' +
      'app you are building. Emails, tokens, keys, and usernames are redacted locally before submission.',
    )
    .option('--type <type>', 'Hurdle kind: bug (should work per contract or docs, but does not) | feature-request (needed something unsupported) | friction (works but confusing/awkward) | other')
    .option('--component <component>', `Toolkit component the issue lives in: ${COMPONENTS.join(' | ')}`)
    .option('--language <language>', 'Language/variant for SDK or docs feedback, e.g. js, python, flutter, swift, kotlin, rest-api (required with --component sdk)')
    .option('--title <title>', `One-line summary (max ${LIMITS.title} chars)`)
    .option('--detail <text>', `What happened vs what you expected; include repro steps if known (max ${LIMITS.detail} chars)`)
    .option('--file <path>', 'Read the detail text from a file instead of --detail')
    .option('--area <area>', 'Product area, e.g. db | auth | storage | functions | deployments | billing | ai | realtime | payments')
    .option('--command <command>', 'The CLI command or SDK call that surfaced the issue')
    .option('--error <text>', 'Verbatim error output (redacted and truncated automatically)')
    .option('--expected <text>', 'What the docs/skill instructed, or what you expected to happen')
    .option('--workaround <text>', 'The alternative you used to get past the hurdle, if any')
    .option('--doc <ref>', 'Doc page or skill section that instructed it (when docs/skill contradict actual behavior)')
    .option('--severity <severity>', `${SEVERITIES.join(' | ')}`, 'minor')
    .action(async (opts: FeedbackOpts, cmd) => {
      // No auth required: the feedback endpoint is public (anon key) so OSS
      // and logged-out users can report hurdles too. Anti-spam lives
      // server-side in the submit-feedback edge function.
      const { json } = getRootOpts(cmd);
      try {
        let detail = opts.file ? readFileSync(opts.file, 'utf8') : opts.detail;
        let { type, component, language, title } = opts;

        // Humans get prompted for missing required fields; agents (non-TTY or
        // --json) get a precise error instead so nothing hangs on a prompt.
        const missingRequired =
          !type || !component || !title || !detail || (component === 'sdk' && !language);
        if (missingRequired && prompts.isInteractive && !json) {
          ({ type, component, language, title, detail } = await promptMissing({
            type, component, language, title, detail,
          }));
        }

        if (!type || !(TYPES as readonly string[]).includes(type)) {
          throw new CLIError(`--type is required and must be one of: ${TYPES.join(', ')}`);
        }
        if (!component || !(COMPONENTS as readonly string[]).includes(component)) {
          throw new CLIError(
            `--component is required and must be one of: ${COMPONENTS.join(', ')} — where in the InsForge toolkit the issue lives.`,
          );
        }
        if (component === 'sdk' && !language?.trim()) {
          throw new CLIError(
            '--language is required for SDK feedback, e.g. js, python, flutter, swift, kotlin — or "multiple" if it spans SDKs.',
          );
        }
        if (!title?.trim()) {
          throw new CLIError('--title is required: a one-line summary of the issue.');
        }
        if (!detail?.trim()) {
          throw new CLIError('--detail (or --file) is required: what happened and what you expected.');
        }
        if (!(SEVERITIES as readonly string[]).includes(opts.severity)) {
          throw new CLIError(`--severity must be one of: ${SEVERITIES.join(', ')}`);
        }

        const config = getProjectConfig();
        const ossMode = !config || config.project_id === FAKE_PROJECT_ID;

        const payload: FeedbackPayload = {
          type: type as FeedbackType,
          component: component as FeedbackComponent,
          severity: opts.severity as FeedbackSeverity,
          title: clean(title, LIMITS.title),
          detail: clean(detail, LIMITS.detail),
          language: cleanOptional(language?.toLowerCase(), LIMITS.language),
          area: cleanOptional(opts.area, LIMITS.area),
          command: cleanOptional(opts.command, LIMITS.command),
          error: cleanOptional(opts.error, LIMITS.error),
          expected: cleanOptional(opts.expected, LIMITS.expected),
          workaround: cleanOptional(opts.workaround, LIMITS.workaround),
          doc_ref: cleanOptional(opts.doc, LIMITS.doc),
          // Platform identifiers InsForge already holds — context, not PII.
          project_id: !ossMode ? config?.project_id : undefined,
          org_id: !ossMode ? config?.org_id : undefined,
          region: !ossMode ? config?.region : undefined,
          client_info: {
            source: 'cli',
            cli_version: process.env.CLI_VERSION || 'unknown',
            node_version: process.version,
            os: `${os.platform()} ${os.release()}`,
          },
        };

        const { id, status } = await submitFeedback(payload);

        // Metadata only — never the free-text fields (see DEVELOPMENT.md §2).
        await trackTopLevelUsage('feedback', true, {
          type,
          component,
          language: payload.language,
          severity: opts.severity,
          area: payload.area,
          status,
          has_command: Boolean(payload.command),
          has_error: Boolean(payload.error),
          has_workaround: Boolean(payload.workaround),
          detail_length: payload.detail.length,
          oss_mode: ossMode,
        });

        if (json) {
          outputJson({ id, status });
        } else if (status === 'duplicate') {
          outputSuccess('This issue was already reported — bumped its count instead. Thank you!');
        } else {
          outputSuccess(`Feedback submitted${id ? ` (id: ${id})` : ''}. Thank you!`);
          outputInfo('PII (emails, tokens, keys, usernames) was redacted before sending.');
        }
      } catch (err) {
        await trackTopLevelUsage('feedback', false, {}, err);
        handleError(err, json);
      }
    });
}
