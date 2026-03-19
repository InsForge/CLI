import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect } from 'vitest';

const execFileAsync = promisify(execFile);

export interface CliExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function getOptionalApiUrl(): string | undefined {
  return process.env.INSFORGE_API_URL?.trim() || undefined;
}

export function getLogSource(): string {
  return process.env.INTEGRATION_LOG_SOURCE?.trim() || 'insforge.logs';
}

export async function runCli(args: string[], opts?: { apiUrl?: string }): Promise<CliExecResult> {
  const node = process.execPath;
  const cliEntrypoint = join(process.cwd(), 'dist', 'index.js');

  try {
    const { stdout, stderr } = await execFileAsync(node, [cliEntrypoint, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        INSFORGE_API_URL: opts?.apiUrl,
      },
      maxBuffer: 1024 * 1024,
    });

    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
    };
  }
}

export function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error('CLI returned empty output; expected JSON output.');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const firstBracket = trimmed.indexOf('[');
    const first = [firstBrace, firstBracket].filter((v) => v >= 0).sort((a, b) => a - b)[0];
    if (first === undefined) {
      throw new Error(`Unable to parse JSON output: ${trimmed.slice(0, 300)}`);
    }
    return JSON.parse(trimmed.slice(first));
  }
}

export function expectCliSuccess(result: CliExecResult): void {
  expect(result.code, `Expected exit code 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
  expect(result.stderr.trim(), `Expected empty stderr\nstderr:\n${result.stderr}`).toBe('');
}

export function expectNoErrorPayload(payload: unknown): void {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const err = (payload as Record<string, unknown>).error;
    throw new Error(`CLI returned error payload: ${String(err)}`);
  }
}
