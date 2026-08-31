import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerDbExportCommand, extractExportContent } from './export.js';

vi.mock('../../lib/api/oss.js', () => ({
  ossFetch: vi.fn(),
}));
vi.mock('../../lib/credentials.js', () => ({
  requireAuth: vi.fn(async () => {}),
}));
vi.mock('../../lib/command-telemetry.js', () => ({
  trackCommandUsage: vi.fn(async () => {}),
}));

import { ossFetch } from '../../lib/api/oss.js';

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>');
  const dbCmd = program.command('db');
  registerDbExportCommand(dbCmd);
  return program;
}

function mockExportResponse(body: string) {
  (ossFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    text: async () => body,
  });
}

describe('extractExportContent', () => {
  it('unwraps a { content } envelope', () => {
    expect(extractExportContent({ format: 'sql', content: 'CREATE TABLE a ();' })).toBe(
      'CREATE TABLE a ();',
    );
  });

  it('unwraps a { data } envelope', () => {
    expect(extractExportContent({ format: 'sql', data: 'CREATE TABLE a ();' })).toBe(
      'CREATE TABLE a ();',
    );
  });

  it('prefers content over data when both are present', () => {
    expect(extractExportContent({ content: 'from-content', data: 'from-data' })).toBe(
      'from-content',
    );
  });

  it('returns null for non-string content/data', () => {
    expect(extractExportContent({ format: 'json', data: { tables: [] } })).toBeNull();
    expect(extractExportContent({ rows: [1, 2, 3] })).toBeNull();
  });
});

describe('db export -o', () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'insforge-export-test-'));
    return () => rmSync(dir, { recursive: true, force: true });
  });

  it('writes raw SQL when the backend returns a { format, data } envelope', async () => {
    const sql = 'CREATE TABLE users (id uuid PRIMARY KEY);';
    mockExportResponse(JSON.stringify({ format: 'sql', data: sql, tables: ['users'] }));
    const outFile = join(dir, 'dump.sql');

    await makeProgram().parseAsync(
      ['db', 'export', '--format', 'sql', '-o', outFile],
      { from: 'user' },
    );

    expect(readFileSync(outFile, 'utf-8')).toBe(sql);
  });

  it('writes raw SQL when the backend returns a { format, content } envelope', async () => {
    const sql = 'CREATE TABLE posts (id serial);';
    mockExportResponse(JSON.stringify({ format: 'sql', content: sql, tables: ['posts'] }));
    const outFile = join(dir, 'dump.sql');

    await makeProgram().parseAsync(
      ['db', 'export', '--format', 'sql', '-o', outFile],
      { from: 'user' },
    );

    expect(readFileSync(outFile, 'utf-8')).toBe(sql);
  });

  it('writes the response verbatim when it is not an envelope', async () => {
    const raw = '-- raw sql dump\nCREATE TABLE t ();';
    mockExportResponse(raw);
    const outFile = join(dir, 'dump.sql');

    await makeProgram().parseAsync(
      ['db', 'export', '--format', 'sql', '-o', outFile],
      { from: 'user' },
    );

    expect(readFileSync(outFile, 'utf-8')).toBe(raw);
  });
});

describe('db export --json', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes SQL content when the backend returns a { format, data } envelope', async () => {
    const sql = 'CREATE TABLE users (id uuid PRIMARY KEY);';
    mockExportResponse(JSON.stringify({ format: 'sql', data: sql, timestamp: '2026-07-28' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await makeProgram().parseAsync(
      ['--json', 'db', 'export', '--format', 'sql'],
      { from: 'user' },
    );

    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ format: 'sql', content: sql });
    log.mockRestore();
  });
});
