import { describe, expect, it } from 'vitest';
import { buildOssHost } from './config.js';

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
