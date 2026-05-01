import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnvFile } from './env-file.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-env-file-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, contents: string): string {
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

describe('parseEnvFile', () => {
  it('parses plain KEY=VALUE pairs', () => {
    const p = write('plain.env', 'FOO=bar\nBAZ=qux\n');
    expect(parseEnvFile(p)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips blank lines and # comments', () => {
    const p = write('comments.env', '# header comment\n\nFOO=bar\n# inline\nBAZ=qux\n');
    expect(parseEnvFile(p)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips matching surrounding double quotes from values', () => {
    const p = write('dquotes.env', 'GREETING="hello world"\n');
    expect(parseEnvFile(p)).toEqual({ GREETING: 'hello world' });
  });

  it('strips matching surrounding single quotes from values', () => {
    const p = write('squotes.env', "GREETING='hello world'\n");
    expect(parseEnvFile(p)).toEqual({ GREETING: 'hello world' });
  });

  it('preserves # inside quoted values (not a comment)', () => {
    const p = write('hash.env', 'PASSWORD="abc#123"\n');
    expect(parseEnvFile(p)).toEqual({ PASSWORD: 'abc#123' });
  });

  it('strips trailing inline comment from unquoted values', () => {
    const p = write('inline.env', 'PORT=8080 # default port\n');
    expect(parseEnvFile(p)).toEqual({ PORT: '8080' });
  });

  it('preserves "=" inside values (only first equals splits)', () => {
    const p = write('eq.env', 'JWT=a.b=c.d\n');
    expect(parseEnvFile(p)).toEqual({ JWT: 'a.b=c.d' });
  });

  it('rejects invalid keys (lowercase, hyphen)', () => {
    const p = write('badkey.env', 'lower=ok\n');
    expect(() => parseEnvFile(p)).toThrow(/invalid env var key/);
  });

  it('rejects malformed lines (no equals)', () => {
    const p = write('malformed.env', 'NOT_A_PAIR\n');
    expect(() => parseEnvFile(p)).toThrow(/expected KEY=VALUE/);
  });

  it('reports the line number on errors', () => {
    const p = write('linenum.env', 'GOOD=ok\n\nBAD\n');
    expect(() => parseEnvFile(p)).toThrow(/:3:/);
  });

  it('throws CLIError when file does not exist', () => {
    expect(() => parseEnvFile(join(dir, 'nope.env'))).toThrow(/Could not read --env-file/);
  });

  it('handles CRLF line endings', () => {
    const p = write('crlf.env', 'FOO=bar\r\nBAZ=qux\r\n');
    expect(parseEnvFile(p)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });
});
