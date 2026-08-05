/**
 * Resolve the newest InsForge release tag from GHCR.
 *
 * Why not just leave the compose file on `:latest`: Docker won't re-pull a tag it
 * already has locally, so `latest` gives neither reproducibility (two users get
 * different images) nor freshness (a months-old local copy is never refreshed).
 * And the backend runs `migrate:up` on boot, so an unannounced version change can
 * leave a schema an older image can't read.
 *
 * So: pick the newest release tag present in every image on the release train and
 * record it, via the same INSFORGE_STACK_TAG the compose file already reads. A
 * directory resolves once at first start and never moves again.
 *
 * Postgres is deliberately not on this train — the local overlay uses the base
 * ghcr.io/insforge/postgres image, which carries its own upstream versioning.
 *
 * Every failure path returns null and the caller leaves the compose file on its
 * `:latest` defaults — a network problem must not break `local start`.
 */

const GHCR = 'https://ghcr.io';
const OWNER = 'insforge';

/** Images pinned together by one release tag. */
export const STACK_REPOS = ['insforge-oss', 'deno-runtime'];

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;



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

/**
 * Resolve the newest release tag common to every image on the train, or null.
 *
 * `timeoutMs` bounds the whole operation rather than each request, so a slow
 * registry delays the first start by at most that much before falling back.
 */
export async function resolveStackTag(timeoutMs = 8_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const tagLists = await Promise.all(
      STACK_REPOS.map((repo) => listTags(repo, controller.signal)),
    );
    return newestCommonTag(tagLists);
  } catch {
    // Offline, DNS failure, registry outage, abort — all mean "use the defaults".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which release-train repos do NOT publish `tag`. Empty means the tag is usable.
 *
 * Called before honoring `--stack-tag`, because compose would otherwise fail deep
 * in a pull with a bare "not found" that doesn't say which image is missing or
 * why. Returns empty on a registry error so a network problem can't block an
 * otherwise valid pin — the pull is the backstop.
 */
export async function missingStackTagRepos(
  tag: string,
  timeoutMs = 8_000,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const results = await Promise.all(
      STACK_REPOS.map(async (repo) => ({
        repo,
        tags: await listTags(repo, controller.signal),
      })),
    );
    // An empty list means the lookup itself failed; don't report that as missing.
    return results.filter((r) => r.tags.length > 0 && !r.tags.includes(tag)).map((r) => r.repo);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
