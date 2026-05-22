import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadMarketplaceTemplate, reportMarketplaceDownload } from './create';
import type { ProjectConfig } from '../types';

const here = dirname(fileURLToPath(import.meta.url));
const createSource: string = readFileSync(join(here, 'create.ts'), 'utf8');

const dummyProjectConfig = {} as ProjectConfig;

describe('reportMarketplaceDownload', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /templates/v1/<slug>/downloads on the given apiUrl', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 1 }) });

    await reportMarketplaceDownload('chatbot', 'https://api.insforge.dev');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.insforge.dev/templates/v1/chatbot/downloads');
    expect(init).toMatchObject({ method: 'POST' });
  });

  it('URL-encodes the slug', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 1 }) });

    await reportMarketplaceDownload('weird slug', 'https://api.insforge.dev');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('weird%20slug');
  });

  it('swallows network errors (does not throw)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      reportMarketplaceDownload('chatbot', 'https://api.insforge.dev'),
    ).resolves.toBeUndefined();
  });

  it('swallows non-2xx responses (does not throw)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    await expect(
      reportMarketplaceDownload('chatbot', 'https://api.insforge.dev'),
    ).resolves.toBeUndefined();
  });
});

describe('downloadMarketplaceTemplate slug validation', () => {
  // Slug must shape-match the registry regex before we touch the filesystem.
  // This blocks path traversal (../, /abs, etc.) before path.join can be abused.

  it('rejects parent-directory traversal', async () => {
    await expect(
      downloadMarketplaceTemplate('../etc', dummyProjectConfig, true),
    ).rejects.toThrow(/Invalid --marketplace slug/);
  });

  it('rejects absolute path slugs', async () => {
    await expect(
      downloadMarketplaceTemplate('/etc/passwd', dummyProjectConfig, true),
    ).rejects.toThrow(/Invalid --marketplace slug/);
  });

  it('rejects slugs with uppercase or special chars', async () => {
    await expect(
      downloadMarketplaceTemplate('FooBar', dummyProjectConfig, true),
    ).rejects.toThrow(/Invalid --marketplace slug/);
    await expect(
      downloadMarketplaceTemplate('foo bar', dummyProjectConfig, true),
    ).rejects.toThrow(/Invalid --marketplace slug/);
  });

  it('rejects empty slug', async () => {
    await expect(
      downloadMarketplaceTemplate('', dummyProjectConfig, true),
    ).rejects.toThrow(/Invalid --marketplace slug/);
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
    // The action handler must reject a bad slug BEFORE auth + project creation.
    // Verify the regex check appears before the `await requireAuth(` call so
    // the defense-in-depth check inside downloadMarketplaceTemplate is not the
    // only line of defense.
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

  it('gates reportMarketplaceDownload on the downloaded boolean', () => {
    // The counter ping must only fire when downloadMarketplaceTemplate returns
    // true — a swallowed network/clone failure (return false) must NOT bump
    // the marketplace's install count.
    expect(createSource).toMatch(/const downloaded = await downloadMarketplaceTemplate/);
    expect(createSource).toMatch(/if \(downloaded\)[\s\S]{0,80}reportMarketplaceDownload/);
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
