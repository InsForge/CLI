/**
 * Resolve the newest InsForge stack from GHCR, by digest.
 *
 * Why not just use `:latest` in the compose file: Docker won't re-pull a tag it
 * already has locally, so `latest` gives neither reproducibility (two users get
 * different images) nor freshness (a months-old local copy is never refreshed).
 * And the three images move independently, so latest+latest+latest is an
 * untested combination — while the backend runs `migrate:up` on boot, which can
 * leave a schema an older image can't read.
 *
 * So: pick the newest release tag that exists in ALL THREE repos (same tag ⇒
 * built from the same commit by the same CI run ⇒ a combination that was tested
 * together), pin each image to its digest, and record it. A directory resolves
 * once at first start and never moves again.
 *
 * Every failure path returns null and the caller falls back to the tags baked
 * into the bundled compose file — a network problem must not break `local start`.
 */

const GHCR = 'https://ghcr.io';
const OWNER = 'insforge';

/** Compose service name → GHCR repository name, for images we publish. */
export const STACK_REPOS: Record<string, string> = {
  insforge: 'insforge-oss',
  postgres: 'postgres-all',
  deno: 'deno-runtime',
};

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export interface ResolvedStack {
  tag: string;
  /** Service name → `ghcr.io/insforge/<repo>@sha256:…`. */
  images: Record<string, string>;
}

/** Descending semver sort. Prereleases are excluded by RELEASE_TAG. */
export function sortReleaseTagsDesc(tags: string[]): string[] {
  return tags
    .filter((t) => RELEASE_TAG.test(t))
    .sort((a, b) => {
      const pa = RELEASE_TAG.exec(a)!.slice(1).map(Number);
      const pb = RELEASE_TAG.exec(b)!.slice(1).map(Number);
      for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pb[i] - pa[i];
      }
      return 0;
    });
}

/** Newest tag present in every list. Empty when the lists don't intersect. */
export function newestCommonTag(tagLists: string[][]): string | null {
  if (tagLists.length === 0) return null;
  const [first, ...rest] = tagLists.map((tags) => new Set(sortReleaseTagsDesc(tags)));
  const common = [...first].filter((tag) => rest.every((s) => s.has(tag)));
  return sortReleaseTagsDesc(common)[0] ?? null;
}

async function anonymousToken(repo: string, signal: AbortSignal): Promise<string | null> {
  const url = `${GHCR}/token?service=ghcr.io&scope=repository:${OWNER}/${repo}:pull`;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const body = (await res.json()) as { token?: string };
  return body.token ?? null;
}

/** Parse the `rel="next"` target out of a registry Link header. */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(header);
  return match ? match[1] : null;
}

/**
 * List every tag in a repo, following pagination.
 *
 * This MUST page: GHCR caps a response at 1000 tags and orders them
 * lexicographically, so the first page of `insforge-oss` is the OLDEST tags —
 * reading only page one picks v2.1.1 as "newest" while v2.2.9 exists. Capped at
 * MAX_PAGES so a pathological repo can't spin here.
 */
async function listTags(repo: string, signal: AbortSignal): Promise<string[]> {
  const token = await anonymousToken(repo, signal);
  if (!token) return [];

  const MAX_PAGES = 20;
  const tags: string[] = [];
  let path: string | null = `/v2/${OWNER}/${repo}/tags/list?n=1000`;

  for (let page = 0; path && page < MAX_PAGES; page++) {
    const res: Response = await fetch(`${GHCR}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) break;
    const body = (await res.json()) as { tags?: string[] | null };
    tags.push(...(body.tags ?? []));
    path = parseNextLink(res.headers.get('link'));
  }

  return tags;
}

async function manifestDigest(
  repo: string,
  tag: string,
  signal: AbortSignal,
): Promise<string | null> {
  const token = await anonymousToken(repo, signal);
  if (!token) return null;
  const res = await fetch(`${GHCR}/v2/${OWNER}/${repo}/manifests/${tag}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    signal,
  });
  if (!res.ok) return null;
  return res.headers.get('docker-content-digest');
}

/**
 * Resolve the stack. `timeoutMs` bounds the whole operation, not each request,
 * so a slow registry delays the first start by at most that much before we fall
 * back to the compose defaults.
 */
export async function resolveStack(timeoutMs = 8_000): Promise<ResolvedStack | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const services = Object.keys(STACK_REPOS);
    const tagLists = await Promise.all(
      services.map((s) => listTags(STACK_REPOS[s], controller.signal)),
    );
    const tag = newestCommonTag(tagLists);
    if (!tag) return null;

    const digests = await Promise.all(
      services.map((s) => manifestDigest(STACK_REPOS[s], tag, controller.signal)),
    );
    if (digests.some((d) => !d)) return null;

    const images: Record<string, string> = {};
    services.forEach((service, i) => {
      images[service] = `${GHCR.replace('https://', '')}/${OWNER}/${STACK_REPOS[service]}@${digests[i]}`;
    });
    return { tag, images };
  } catch {
    // Offline, DNS failure, registry outage, abort — all mean "use the defaults".
    return null;
  } finally {
    clearTimeout(timer);
  }
}
