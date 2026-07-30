import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOssHost, getProjectConfig, FAKE_PROJECT_ID, FAKE_ORG_ID } from './config.js';

describe('buildOssHost', () => {
  it('always returns an https URL', () => {
    expect(buildOssHost('p1ky-x9p', 'us-east')).toBe(
      'https://p1ky-x9p.us-east.insforge.app',
    );
  });

  // Regression for the bug where `branch switch` wrote a bare hostname into
  // oss_host and every later fetch threw "Failed to parse URL". Asserting the
  // scheme directly here (independent of any caller) catches future drift.
  it('output is parseable as a URL', () => {
    const url = new URL(buildOssHost('app', 'eu-west'));
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('app.eu-west.insforge.app');
  });
});

describe('getProjectConfig — legacy OSS sentinel ID healing', () => {
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-config-test-'));
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

  // Regression for self-hosted projects linked with CLI ≤0.1.47: those builds
  // wrote 'oss-project'/'oss-org' (or interim fake UUIDs) instead of
  // FAKE_PROJECT_ID/FAKE_ORG_ID, so requireAuth's OSS bypass never matched and
  // db/functions commands redirected to cloud OAuth.
  it.each([
    ['oss-project', 'oss-org'],
    ['fa4e0000-1234-5678-90ab-0e02b2c3d479', 'fa4e0001-1234-5678-90ab-0e02b2c3d479'],
  ])('normalizes legacy sentinel %s to FAKE_PROJECT_ID/FAKE_ORG_ID', (projectId, orgId) => {
    writeProjectJson(projectId, orgId);
    const config = getProjectConfig();
    expect(config?.project_id).toBe(FAKE_PROJECT_ID);
    expect(config?.org_id).toBe(FAKE_ORG_ID);
  });

  it('leaves real cloud project/org IDs untouched', () => {
    writeProjectJson(
      '4b8a1c2e-9d3f-4a5b-8c7d-6e5f4a3b2c1d',
      '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d',
    );
    const config = getProjectConfig();
    expect(config?.project_id).toBe('4b8a1c2e-9d3f-4a5b-8c7d-6e5f4a3b2c1d');
    expect(config?.org_id).toBe('1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d');
  });
});
