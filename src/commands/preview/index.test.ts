import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerPreviewCommands } from './index.js';

describe('registerPreviewCommands', () => {
  it('registers a hidden `preview` command group', () => {
    const program = new Command();
    registerPreviewCommands(program);
    const found = program.commands.find((c) => c.name() === 'preview');
    expect(found).toBeDefined();
    // hidden commands are excluded from help output
    expect((found as unknown as { _hidden?: boolean })._hidden).toBe(true);
  });
});
