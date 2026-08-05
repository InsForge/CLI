import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Command } from 'commander';
import { registerAiOverviewCommand } from './overview.js';

vi.mock('../../lib/api/ai.js', () => ({
  getAiOverview: vi.fn(async () => ({
    key: {
      label: 'insforge-managed',
      limit: 100,
      limitRemaining: 87.66,
      usage: 12.34,
      usageDaily: 0.12,
      usageWeekly: 1.23,
      usageMonthly: 4.56,
      observabilityAvailable: true,
    },
    charts: { spend: [], requests: [], tokens: [] },
    modelUsage: [
      {
        model: 'anthropic/claude-sonnet-5',
        providers: ['anthropic'],
        requests: 42,
        promptTokens: 1000,
        completionTokens: 2000,
        reasoningTokens: 0,
        totalTokens: 3000,
        spend: 1.5,
        byokSpend: 0,
      },
    ],
  })),
}));

vi.mock('../../lib/command-telemetry.js', () => ({
  trackCommandUsage: vi.fn(async () => {}),
}));

function makeProgram() {
  const program = new Command().exitOverride();
  program.option('--json').option('--api-url <url>');
  const aiCmd = program.command('ai');
  registerAiOverviewCommand(aiCmd);
  return program;
}

async function runWithCapturedLog(program: Command, argv: string[]): Promise<string[]> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    logSpy.mockRestore();
  }
  return logs;
}

describe('ai overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('--json emits the full overview payload', async () => {
    const logs = await runWithCapturedLog(makeProgram(), ['ai', 'overview', '--json']);
    const data = JSON.parse(logs.join('\n')) as { key: { usage: number } };
    expect(data.key.usage).toBe(12.34);
  });

  it('human output shows total usage, limit, and remaining', async () => {
    const logs = await runWithCapturedLog(makeProgram(), ['ai', 'overview']);
    const out = logs.join('\n');
    expect(out).toContain('Usage (total):    $12.34');
    expect(out).toContain('Limit:            $100.00');
    expect(out).toContain('Remaining:        $87.66');
    expect(out).toContain('anthropic/claude-sonnet-5');
  });

  it('renders an unlimited key without a numeric limit', async () => {
    const { getAiOverview } = await import('../../lib/api/ai.js');
    (getAiOverview as Mock).mockResolvedValueOnce({
      key: {
        limit: null,
        limitRemaining: null,
        usage: 5,
        usageDaily: 0,
        usageWeekly: 0,
        usageMonthly: 5,
        observabilityAvailable: false,
        observabilityError: 'management key required',
      },
      charts: { spend: [], requests: [], tokens: [] },
    });
    const logs = await runWithCapturedLog(makeProgram(), ['ai', 'overview']);
    const out = logs.join('\n');
    expect(out).toContain('Limit:            unlimited');
    expect(out).toContain('management key required');
  });
});
