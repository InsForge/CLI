import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// If the OSS bypass regresses, requireAuth falls through to browser OAuth —
// mock auth.js so the test fails fast instead of opening a browser.
vi.mock('./auth.js', () => ({
  DEFAULT_CLIENT_ID: 'test-client',
  refreshOAuthToken: vi.fn(() => Promise.reject(new Error('unexpected OAuth refresh'))),
  performOAuthLogin: vi.fn(() => Promise.reject(new Error('unexpected OAuth login'))),
}));

import { FAKE_PROJECT_ID, FAKE_ORG_ID } from './config.js';
import { requireAuth } from './credentials.js';

describe('requireAuth — OSS bypass for self-hosted links', () => {
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-oss-bypass-'));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  function writeProjectJson(projectId: string, orgId: string): void {
    mkdirSync(join(dir, '.insforge'), { recursive: true });
    writeFileSync(
      join(dir, '.insforge', 'project.json'),
      JSON.stringify({
        project_id: projectId,
        project_name: 'oss-project',
        org_id: orgId,
        appkey: 'ossfkey',
        region: 'us-test',
        api_key: 'ins_test',
        oss_host: 'http://localhost:7130',
      }),
    );
  }

  // Regression for self-hosted projects linked with CLI ≤0.1.47: db/functions
  // commands redirected to cloud OAuth because the stored sentinel predated
  // FAKE_PROJECT_ID and the bypass never matched.
  it.each([
    [FAKE_PROJECT_ID, FAKE_ORG_ID],
    ['oss-project', 'oss-org'],
    ['fa4e0000-1234-5678-90ab-0e02b2c3d479', 'fa4e0001-1234-5678-90ab-0e02b2c3d479'],
  ])('returns the OSS stub without OAuth for project_id %s', async (projectId, orgId) => {
    writeProjectJson(projectId, orgId);
    const creds = await requireAuth();
    expect(creds.access_token).toBe('oss-token');
    expect(creds.user.email).toBe('oss@insforge.local');
  });
});
