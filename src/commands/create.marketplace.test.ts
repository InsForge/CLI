import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportMarketplaceDownload } from './create';

const here = dirname(fileURLToPath(import.meta.url));
const createSource: string = readFileSync(join(here, 'create.ts'), 'utf8');

describe('reportMarketplaceDownload', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs slug body to TemplateMarket /functions/report-download', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 1 }) });

    await reportMarketplaceDownload('chatbot');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://p8n7m7ci.us-east.insforge.app/functions/report-download');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'chatbot' }),
    });
  });

  it('sends the slug verbatim in the JSON body (no URL encoding hazard)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 1 }) });

    await reportMarketplaceDownload('weird slug');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(JSON.stringify({ slug: 'weird slug' }));
  });

  it('swallows network errors (does not throw)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(reportMarketplaceDownload('chatbot')).resolves.toBeUndefined();
  });

  it('swallows non-2xx responses (does not throw)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    await expect(reportMarketplaceDownload('chatbot')).resolves.toBeUndefined();
  });
});

describe('--marketplace flag wiring', () => {
  // These tests read the source of create.ts and assert structural invariants
  // (presence of mutual-exclusion check, branch ordering, absence of PostHog
  // payload changes). The full command involves auth + network and isn't unit-
  // testable without heavy mocking; this layer guards against silent refactors
  // that would drop the wiring.

  it('asserts the flag is mutually exclusive with --template at action entry', () => {
    expect(createSource).toContain('--marketplace and --template are mutually exclusive');
    expect(createSource).toMatch(/if \(opts\.marketplace && opts\.template\)/);
  });

  it('validates the slug at action entry before requireAuth (no orphaned project)', () => {
    // Slug regex MUST run before auth + project creation, otherwise a bad
    // slug throws after the platform project already exists. With the
    // standalone downloadMarketplaceTemplate function gone (marketplace now
    // reuses downloadGitHubTemplate), the action-level check is the only
    // line of defense — its position is load-bearing.
    const slugCheckIdx = createSource.indexOf(
      'SAFE_MARKETPLACE_SLUG.test(opts.marketplace',
    );
    const requireAuthIdx = createSource.indexOf('await requireAuth(');
    expect(slugCheckIdx).toBeGreaterThan(0);
    expect(slugCheckIdx).toBeLessThan(requireAuthIdx);
  });

  it('exposes the marketplace branch ahead of the githubTemplates branch in the download switch', () => {
    const marketplaceIdx = createSource.indexOf('if (opts.marketplace) {');
    const githubIdx = createSource.indexOf('githubTemplates.includes');
    expect(marketplaceIdx).toBeGreaterThan(0);
    expect(githubIdx).toBeGreaterThan(marketplaceIdx);
  });

  it('gates reportMarketplaceDownload on the downloaded boolean from downloadGitHubTemplate', () => {
    // The counter ping must only fire when downloadGitHubTemplate returns
    // true — a swallowed network/clone failure (return false) must NOT bump
    // the marketplace's install count.
    expect(createSource).toMatch(/const downloaded = await downloadGitHubTemplate/);
    expect(createSource).toMatch(/if \(downloaded\)[\s\S]{0,200}reportMarketplaceDownload/);
  });

  it('does NOT emit a PostHog template_selected event with a marketplace property', () => {
    // template_selected still fires for the marketplace path (with template='empty'
    // from the picker bypass) but its payload must not carry a 'marketplace' key.
    expect(createSource).toMatch(/captureEvent\(orgId, 'template_selected'/);
    const callIdx = createSource.indexOf("captureEvent(orgId, 'template_selected'");
    const closingParen = createSource.indexOf(');', callIdx);
    const callText = createSource.slice(callIdx, closingParen);
    expect(callText).not.toMatch(/marketplace/);
  });
});
