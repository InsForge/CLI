/**
 * Render the compose file the CLI runs.
 *
 * `docker-compose.template.yml` ships with the CLI and carries an
 * `__INSFORGE_CONFIGS__` marker. Rendering replaces it with a top-level
 * `configs:` block holding the literal contents of db-init.sql, server.ts and
 * worker-template.js, which the services then mount by name.
 *
 * Why inline rather than bind-mount the three files: a bind mount needs the host
 * path to be shared with the Docker VM (a prompt or a hard failure on Docker
 * Desktop for Windows) and needs an SELinux relabel on RHEL-family hosts. Compose
 * configs are streamed to the daemon, so neither applies. Supabase's CLI reaches
 * the same conclusion by a different route — it embeds its SQL in the binary and
 * writes it into the container with a heredoc.
 */

import { CLIError } from '../errors.js';

export const CONFIGS_MARKER = '__INSFORGE_CONFIGS__';

/**
 * The marker on a line of its own. Anchored deliberately: the template's own
 * header comment names the token, and a plain string replace would substitute
 * that mention instead, injecting the block into the middle of a comment and
 * leaving the real marker in place.
 */
const MARKER_LINE = new RegExp(`^${CONFIGS_MARKER}$`, 'm');

/** Compose config name → the file whose contents it carries. */
export interface ConfigSource {
  name: string;
  content: string;
}

/**
 * Escape `$` so Compose's interpolation leaves it alone.
 *
 * Compose interpolates `${...}` across the whole file, config payloads included.
 * server.ts is TypeScript full of template literals, so unescaped it fails the
 * project outright with "invalid interpolation format for configs.deno_server
 * .content". `$$` is Compose's literal-dollar escape, so doubling every `$` is
 * lossless — verified by comparing checksums inside the container.
 */
export function escapeDollars(content: string): string {
  return content.replace(/\$/g, '$$$$');
}

/**
 * Indent a file's contents to sit under a YAML `content: |` block scalar.
 *
 * Empty lines stay empty rather than becoming whitespace-only: a block scalar
 * ends at the first line indented less than the block, and an unindented blank
 * line is not treated as such, but trailing spaces on it would survive into the
 * file for no reason. Every other line gets exactly `indent` spaces, so the
 * original relative indentation is preserved verbatim.
 */
export function toBlockScalar(content: string, indent: number): string {
  const pad = ' '.repeat(indent);
  return content
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n');
}

/**
 * Build the top-level `configs:` block.
 *
 * `content:` is a YAML block scalar, so the payload is never parsed as YAML —
 * SQL quoting, TypeScript backticks and `#` characters all pass through as-is.
 */
export function renderConfigsBlock(sources: ConfigSource[]): string {
  if (sources.length === 0) return '';
  const lines = ['configs:'];
  for (const { name, content } of sources) {
    lines.push(`  ${name}:`, '    content: |');
    lines.push(toBlockScalar(escapeDollars(content), 6));
  }
  return lines.join('\n');
}

/** Substitute the marker in the template. Throws if the template lost it. */
export function renderComposeFile(template: string, sources: ConfigSource[]): string {
  if (!MARKER_LINE.test(template)) {
    throw new CLIError(
      `The bundled compose template has no ${CONFIGS_MARKER} line.\n` +
        'Reinstall with `npx -y @insforge/cli@latest`.',
    );
  }
  // A function replacer, not a string: in a replacement *string* `$$` means one
  // literal `$`, so passing the block directly would undo the escaping that
  // escapeDollars just applied and hand Compose an uninterpolatable file.
  const block = renderConfigsBlock(sources);
  return template.replace(MARKER_LINE, () => block);
}
