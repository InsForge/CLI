import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfig } from '../types.js';
import {
  AGENTS_MD_END,
  AGENTS_MD_START,
  buildInsforgeBlock,
  mergeAgentsMd,
  writeLocalAgentsMd,
} from './agents-md.js';

const config: ProjectConfig = {
  project_id: 'p1',
  project_name: 'My App',
  org_id: 'o1',
  appkey: 'abc',
  region: 'us-east',
  api_key: 'super-secret-key-xyz',
  oss_host: 'https://abc.us-east.insforge.app',
};

describe('buildInsforgeBlock', () => {
  it('wraps content in the InsForge markers', () => {
    const block = buildInsforgeBlock(null);
    expect(block.startsWith(AGENTS_MD_START)).toBe(true);
    expect(block.trimEnd().endsWith(AGENTS_MD_END)).toBe(true);
  });

  it('explains what InsForge is', () => {
    const block = buildInsforgeBlock(null);
    expect(block).toContain('InsForge');
    expect(block.toLowerCase()).toContain('backend');
  });

  it('tells the agent when to use the installed skills', () => {
    const block = buildInsforgeBlock(null);
    expect(block.toLowerCase()).toContain('skill');
    expect(block.toLowerCase()).toContain('before implementing');
  });

  it('includes the high-leverage correctness patterns', () => {
    const block = buildInsforgeBlock(null);
    expect(block).toContain('insert([{');
    expect(block).toContain('auth.users(id)');
    expect(block).toContain('auth.uid()');
  });

  it('includes project name and API host when config is present', () => {
    const block = buildInsforgeBlock(config);
    expect(block).toContain('My App');
    expect(block).toContain('https://abc.us-east.insforge.app');
  });

  it('never leaks the api_key (the file is committed)', () => {
    expect(buildInsforgeBlock(config)).not.toContain('super-secret-key-xyz');
  });
});

describe('mergeAgentsMd', () => {
  it('creates a fresh file with a heading when none exists', () => {
    const out = mergeAgentsMd(null, config);
    expect(out).toContain('# AGENTS.md');
    expect(out).toContain(AGENTS_MD_START);
    expect(out).toContain(AGENTS_MD_END);
  });

  it('appends the block to an existing file, preserving user content', () => {
    const existing = '# My rules\n\nAlways write tests.\n';
    const out = mergeAgentsMd(existing, config);
    expect(out).toContain('Always write tests.');
    expect(out.indexOf('Always write tests.')).toBeLessThan(out.indexOf(AGENTS_MD_START));
  });

  it('replaces an existing InsForge block in place (no duplication)', () => {
    const first = mergeAgentsMd('# My rules\n\nKeep it.\n', config);
    const second = mergeAgentsMd(first, config);
    expect(second).toBe(first); // idempotent
    expect(second.match(/INSFORGE:START/g)).toHaveLength(1);
    expect(second).toContain('Keep it.');
  });

  it('refreshes the block when config changes without growing the file', () => {
    const first = mergeAgentsMd(null, null);
    const refreshed = mergeAgentsMd(first, config);
    expect(refreshed.match(/INSFORGE:START/g)).toHaveLength(1);
    expect(refreshed).toContain('My App');
  });

  it('treats an empty existing file as fresh', () => {
    const out = mergeAgentsMd('   \n', config);
    expect(out).toContain('# AGENTS.md');
  });
});

describe('writeLocalAgentsMd', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-agents-md-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates AGENTS.md in the target directory', () => {
    writeLocalAgentsMd(true, { cwd: dir, config });
    const content = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain(AGENTS_MD_START);
    expect(content).toContain('My App');
  });

  it('is idempotent: a second run leaves the file byte-identical', () => {
    writeLocalAgentsMd(true, { cwd: dir, config });
    const first = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
    writeLocalAgentsMd(true, { cwd: dir, config });
    const second = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
    expect(second).toBe(first);
  });

  it('preserves a pre-existing AGENTS.md and appends the InsForge block', () => {
    const p = join(dir, 'AGENTS.md');
    writeFileSync(p, '# Existing\n\nUser instructions here.\n');
    writeLocalAgentsMd(true, { cwd: dir, config });
    const content = readFileSync(p, 'utf-8');
    expect(content).toContain('User instructions here.');
    expect(content).toContain(AGENTS_MD_START);
  });
});
