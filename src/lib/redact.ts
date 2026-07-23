/**
 * Scrub likely PII and credentials from free text before it leaves the
 * machine (e.g. `insforge feedback` payloads).
 *
 * Deliberately conservative: over-redacting a value the InsForge team could
 * have used is fine; shipping someone's email, token, or username off the
 * device is not. The platform re-scrubs server-side — this is the first line
 * of defense, not the only one. IPv6 and phone numbers are intentionally not
 * matched: their patterns overlap UUIDs/hashes/timestamps too often to redact
 * without destroying diagnostic value.
 */

const REDACTIONS: Array<[RegExp, string]> = [
  // Credentials embedded in URLs: postgres://user:pass@host → keep scheme+host
  [/(\w+:\/\/)([^\s/:@]+):([^\s@]+)@/g, '$1[REDACTED_CREDENTIALS]@'],
  // JWTs: three dot-separated base64url segments, header always starts with eyJ
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, '[REDACTED_JWT]'],
  // Authorization header values
  [/\b[Bb]earer\s+[\w.~+/=-]{8,}/g, 'Bearer [REDACTED]'],
  // Known key formats: InsForge uak_, Stripe sk_/pk_/rk_(live|test)/whsec_,
  // OpenAI/Anthropic-style sk-, GitHub gh*_/github_pat_, AWS AKIA, Slack xox*-
  [/\b(?:uak|whsec|(?:sk|pk|rk)_(?:live|test))_[\w-]{8,}/g, '[REDACTED_KEY]'],
  [/\bsk-[\w-]{16,}/g, '[REDACTED_KEY]'],
  [/\bgh[pousr]_\w{20,}/g, '[REDACTED_KEY]'],
  [/\bgithub_pat_\w{20,}/g, '[REDACTED_KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_KEY]'],
  [/\bxox[baprs]-[\w-]{10,}/g, '[REDACTED_KEY]'],
  // Generic secret assignments: password=..., api_key: "...", ANON_TOKEN=...
  // Allows prefixed key names (DB_PASSWORD, my-secret) via [\w-]*
  [
    /\b([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|appkey))(\s*[=:]\s*)(["']?)[^\s"']{6,}\3/gi,
    '$1$2$3[REDACTED]$3',
  ],
  // Emails
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
  // Home directories — the username segment is PII
  [/(?:\/Users|\/home)\/[\w.-]+/g, '~'],
  [/\b[A-Za-z]:\\Users\\[\w.-]+/g, '~'],
];

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/** Loopback/private/link-local addresses carry no PII and real debug value. */
function isPrivateOrLocal(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function redactSensitive(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(IPV4, (match, a: string, b: string, c: string, d: string) => {
    const octets = [a, b, c, d].map(Number);
    // Octets >255 mean it's a version string or similar, not an address
    if (octets.some((o) => o > 255)) return match;
    return isPrivateOrLocal(octets[0], octets[1]) ? match : '[REDACTED_IP]';
  });
  return out;
}

/**
 * Cap text at roughly `max` chars keeping head and tail — error output tends
 * to carry the signal at both ends (the command echo up top, the actual error
 * at the bottom). The truncation marker is added on top of `max`.
 */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.6);
  const tail = max - head;
  const omitted = text.length - max;
  return `${text.slice(0, head)}\n…[${omitted} chars truncated]…\n${text.slice(text.length - tail)}`;
}
