import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerPreviewCommands } from './index.js';

describe('registerPreviewCommands', () => {
  it('registers `preview` as a usable command', () => {
    const program = new Command();
    registerPreviewCommands(program);
    const found = program.commands.find((c) => c.name() === 'preview');
    expect(found).toBeDefined();
  });

  it('hides `preview` from help output (behavior, not internals)', () => {
    const program = new Command();
    program.name('insforge');
    registerPreviewCommands(program);
    // Assert observable behavior — hidden commands are excluded from help —
    // rather than Commander's private `_hidden` field, which can change.
    expect(program.helpInformation()).not.toContain('preview');
  });
});
