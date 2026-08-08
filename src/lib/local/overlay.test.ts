import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetsDir } from './compose.js';

const overlay = readFileSync(join(assetsDir(), 'cli-overlay.yml'), 'utf-8');

describe('cli-overlay.yml', () => {
  it('binds every published port to loopback', () => {
    const published = [...overlay.matchAll(/^\s*-\s*"([^"]+:\d+)"/gm)].map((m) => m[1]);
    expect(published.length).toBeGreaterThan(0);
    for (const p of published) expect(p).toMatch(/^127\.0\.0\.1:/);
  });

  it('replaces the upstream port list rather than appending to it', () => {
    // Without !override, Compose merges the two lists and upstream's 0.0.0.0
    // entry keeps listening alongside the loopback one this file adds.
    expect(overlay).toMatch(/ports:\s*!override/);
  });

  it('stamps the deployment method so telemetry can tell local starts apart', () => {
    expect(overlay).toMatch(/INSFORGE_DEPLOYMENT_METHOD:\s*cli-local/);
  });
});
