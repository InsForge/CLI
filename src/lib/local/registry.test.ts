import { describe, it, expect } from 'vitest';
import { STACK_REPOS, newestCommonTag, parseNextLink, sortReleaseTagsDesc } from './registry.js';

describe('sortReleaseTagsDesc', () => {
  it('orders numerically, not lexicographically', () => {
    // The bug this guards: string sort puts v2.10.0 before v2.9.0.
    expect(sortReleaseTagsDesc(['v2.9.0', 'v2.10.0', 'v2.2.9'])).toEqual([
      'v2.10.0',
      'v2.9.0',
      'v2.2.9',
    ]);
  });

  it('drops anything that is not a plain release tag', () => {
    expect(
      sortReleaseTagsDesc([
        'v2.2.9',
        'latest',
        'v2.2.9-test',
        'v2.2.9-amd64',
        'sha-abc123',
        'v2.3',
        'v2.3.0',
      ]),
    ).toEqual(['v2.3.0', 'v2.2.9']);
  });

  it('handles an empty list', () => {
    expect(sortReleaseTagsDesc([])).toEqual([]);
  });
});

describe('newestCommonTag', () => {
  it('picks the newest tag present in every repo', () => {
    expect(
      newestCommonTag([
        ['v2.2.9', 'v2.3.0', 'v2.1.0'],
        ['v2.2.9', 'v2.1.0'],
        ['v2.2.9', 'v2.1.0', 'v2.0.0'],
      ]),
    ).toBe('v2.2.9');
  });

  it('returns null when the repos share no release tag', () => {
    // Today's real state: deno-runtime has only :latest, so resolution must
    // decline and let the compose file's :latest defaults stand.
    expect(newestCommonTag([['v2.2.9', 'v2.3.0'], ['latest']])).toBeNull();
  });

  it('returns null for no repos at all', () => {
    expect(newestCommonTag([])).toBeNull();
  });

  it('ignores prerelease and arch-suffixed tags when intersecting', () => {
    expect(
      newestCommonTag([
        ['v2.2.9', 'v2.3.0-rc1'],
        ['v2.2.9', 'v2.3.0-rc1'],
        ['v2.2.9'],
      ]),
    ).toBe('v2.2.9');
  });
});

describe('parseNextLink', () => {
  it('extracts the rel=next target', () => {
    // Paging is load-bearing: GHCR caps a page at 1000 tags and orders them
    // lexicographically, so page one of insforge-oss is the OLDEST tags.
    expect(
      parseNextLink('</v2/insforge/insforge-oss/tags/list?last=v2.1.1-x&n=1000>; rel="next"'),
    ).toBe('/v2/insforge/insforge-oss/tags/list?last=v2.1.1-x&n=1000');
  });

  it('returns null when there is no next page', () => {
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink('')).toBeNull();
    expect(parseNextLink('</v2/x>; rel="prev"')).toBeNull();
  });
});

describe('STACK_REPOS', () => {
  it('covers the images one release tag has to name', () => {
    expect(STACK_REPOS).toEqual(['insforge-oss']);
  });

  // A repo that publishes no release tags disables the whole mechanism, because
  // a tag has to name every repo on the train. deno-runtime was listed here and
  // has never published one, so newestCommonTag always came back empty and every
  // directory silently ran :latest. The CLI does not use that image.
  it('excludes deno-runtime, which the template does not use', () => {
    expect(STACK_REPOS).not.toContain('deno-runtime');
  });

  // Postgres uses the base ghcr.io/insforge/postgres image, versioned upstream by
  // insforge-db — pinning it to an InsForge release tag would never resolve.
  it('excludes postgres', () => {
    expect(STACK_REPOS.some((r) => r.includes('postgres'))).toBe(false);
  });
});
