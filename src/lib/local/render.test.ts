import { describe, it, expect } from 'vitest';
import { escapeDollars, renderComposeFile, renderConfigsBlock, toBlockScalar } from './render.js';

const TEMPLATE = 'head\n__INSFORGE_CONFIGS__\nservices:\n  a: {}\n';

describe('escapeDollars', () => {
  it('doubles every $ so Compose treats it as a literal', () => {
    expect(escapeDollars('`${slug}`')).toBe('`$${slug}`');
  });

  it('handles SQL dollar-quoting, which is already $$', () => {
    expect(escapeDollars('AS $$ x $$;')).toBe('AS $$$$ x $$$$;');
  });
});

describe('renderComposeFile', () => {
  it('keeps the escaping intact through the substitution', () => {
    // The bug this guards: passing the block as a replacement *string* makes
    // String.replace read `$$` as one literal `$`, silently undoing the escaping
    // and leaving Compose with "invalid interpolation format".
    const out = renderComposeFile(TEMPLATE, [{ name: 'a', content: '`${slug}`' }]);
    expect(out).toContain('$${slug}');
    expect(out).not.toMatch(/(?<!\$)\$\{slug\}/);
  });

  it('substitutes the marker line, not a mention of it in prose', () => {
    const withMention = `# names __INSFORGE_CONFIGS__ inline\n${TEMPLATE}`;
    const out = renderComposeFile(withMention, [{ name: 'a', content: 'x' }]);
    expect(out).toContain('# names __INSFORGE_CONFIGS__ inline');
    expect(out.match(/^configs:$/m)).toBeTruthy();
  });

  it('throws when the template has no marker line', () => {
    expect(() => renderComposeFile('services: {}\n', [])).toThrow(/__INSFORGE_CONFIGS__/);
  });
});

describe('toBlockScalar', () => {
  it('indents content and leaves blank lines truly blank', () => {
    expect(toBlockScalar('a\n\nb\n', 2)).toBe('  a\n\n  b');
  });

  it('preserves the payload\u2019s own relative indentation', () => {
    expect(toBlockScalar('a\n    b', 2)).toBe('  a\n      b');
  });
});

describe('renderConfigsBlock', () => {
  it('is empty when there is nothing to inline', () => {
    expect(renderConfigsBlock([])).toBe('');
  });

  it('emits one named config per source', () => {
    const block = renderConfigsBlock([
      { name: 'one', content: 'x' },
      { name: 'two', content: 'y' },
    ]);
    expect(block.split('\n')).toEqual([
      'configs:',
      '  one:',
      '    content: |',
      '      x',
      '  two:',
      '    content: |',
      '      y',
    ]);
  });
});
