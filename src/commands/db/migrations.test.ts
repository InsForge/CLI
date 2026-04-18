import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ErrorsModule from '../../lib/errors.js';

const ossFetchMock = vi.fn();
const requireAuthMock = vi.fn();
const outputJsonMock = vi.fn();
const outputSuccessMock = vi.fn();
const outputTableMock = vi.fn();
const reportCliUsageMock = vi.fn();

vi.mock('../../lib/api/oss.js', () => ({
  ossFetch: ossFetchMock,
}));

vi.mock('../../lib/credentials.js', () => ({
  requireAuth: requireAuthMock,
}));

vi.mock('../../lib/output.js', () => ({
  outputJson: outputJsonMock,
  outputSuccess: outputSuccessMock,
  outputTable: outputTableMock,
}));

vi.mock('../../lib/skills.js', () => ({
  reportCliUsage: reportCliUsageMock,
}));

vi.mock('../../lib/errors.js', async () => {
  const actual = await vi.importActual<ErrorsModule>('../../lib/errors.js');

  return {
    ...actual,
    handleError: (err: unknown) => {
      throw err;
    },
  };
});

async function buildRootCommand(): Promise<Command> {
  const { registerDbMigrationsCommand } = await import('./migrations.js');
  const root = new Command();
  root.name('insforge');
  root.option('--json');
  const dbCmd = root.command('db');
  registerDbMigrationsCommand(dbCmd);
  return root;
}

describe('db migrations fetch', () => {
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'insforge-migrations-'));
    process.chdir(tempDir);

    vi.clearAllMocks();
    requireAuthMock.mockResolvedValue({ access_token: 'token' });
    reportCliUsageMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects unsafe remote migration names before creating local files', async () => {
    ossFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          migrations: [
            {
              version: '20260418091500',
              name: 'bad/name',
              statements: ['SELECT 1'],
              createdAt: '2026-04-18T09:15:00.000Z',
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    const root = await buildRootCommand();

    await expect(
      root.parseAsync(['db', 'migrations', 'fetch'], { from: 'user' }),
    ).rejects.toThrow(/lowercase letters, numbers, and hyphens only/i);

    const migrationsDir = join(tempDir, '.insforge', 'migrations');
    expect(existsSync(migrationsDir)).toBe(true);
    expect(readdirSync(migrationsDir)).toEqual([]);
    expect(reportCliUsageMock).toHaveBeenCalledWith('cli.db.migrations.fetch', false);
    expect(outputSuccessMock).not.toHaveBeenCalled();
  });
});
