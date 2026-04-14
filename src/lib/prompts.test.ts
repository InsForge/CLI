import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { nonTtyText, nonTtySelect, nonTtyConfirm, isCancel, CANCEL, LineReader } from './prompts.js';

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const reader = new LineReader(input, output);

  const outChunks: string[] = [];
  const errChunks: string[] = [];
  output.on('data', (c) => outChunks.push(c.toString()));
  stderr.on('data', (c) => errChunks.push(c.toString()));

  return {
    reader,
    stdout: output,
    stderr,
    write: (line: string) => input.write(line),
    end: () => input.end(),
    stdout_text: () => outChunks.join(''),
    stderr_text: () => errChunks.join(''),
  };
}

describe('nonTtyText', () => {
  it('reads a single line answer', async () => {
    const h = harness();
    const p = nonTtyText({ message: 'Name?' }, { reader: h.reader, stderr: h.stderr });
    h.write('alice\n');
    expect(await p).toBe('alice');
  });

  it('trims whitespace from input', async () => {
    const h = harness();
    const p = nonTtyText({ message: 'Name?' }, { reader: h.reader, stderr: h.stderr });
    h.write('  bob  \n');
    expect(await p).toBe('bob');
  });

  it('uses initialValue when input is empty', async () => {
    const h = harness();
    const p = nonTtyText({ message: 'Name?', initialValue: 'default' }, { reader: h.reader, stderr: h.stderr });
    h.write('\n');
    expect(await p).toBe('default');
  });

  it('retries when validate returns an error', async () => {
    const h = harness();
    const p = nonTtyText(
      {
        message: 'Name?',
        validate: (v) => (v.length < 3 ? 'too short' : undefined),
      },
      { reader: h.reader, stderr: h.stderr },
    );
    h.write('hi\n');
    h.write('hello\n');
    expect(await p).toBe('hello');
    expect(h.stderr_text()).toContain('too short');
  });

  it('returns CANCEL on stdin EOF', async () => {
    const h = harness();
    const p = nonTtyText({ message: 'Name?' }, { reader: h.reader, stderr: h.stderr });
    h.end();
    expect(await p).toBe(CANCEL);
  });

  it('preserves whitespace when trim is false (for passwords)', async () => {
    const h = harness();
    const p = nonTtyText({ message: 'Secret?', trim: false }, { reader: h.reader, stderr: h.stderr });
    h.write('  spaces matter  \n');
    expect(await p).toBe('  spaces matter  ');
  });
});

describe('nonTtySelect', () => {
  it('resolves numeric answer to the option value', async () => {
    const h = harness();
    const p = nonTtySelect<string>(
      {
        message: 'Pick:',
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
          { value: 'c', label: 'Charlie' },
        ],
      },
      { reader: h.reader, stdout: h.stdout, stderr: h.stderr },
    );
    h.write('2\n');
    expect(await p).toBe('b');
  });

  it('prints numbered list with labels and hints', async () => {
    const h = harness();
    const p = nonTtySelect<string>(
      {
        message: 'Pick:',
        options: [
          { value: 'a', label: 'Alpha', hint: 'the first one' },
          { value: 'b', label: 'Beta' },
        ],
      },
      { reader: h.reader, stdout: h.stdout, stderr: h.stderr },
    );
    h.write('1\n');
    await p;
    const out = h.stdout_text();
    expect(out).toContain('1) Alpha');
    expect(out).toContain('the first one');
    expect(out).toContain('2) Beta');
  });

  it('retries on out-of-range input', async () => {
    const h = harness();
    const p = nonTtySelect<string>(
      {
        message: 'Pick:',
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ],
      },
      { reader: h.reader, stdout: h.stdout, stderr: h.stderr },
    );
    h.write('5\n');
    h.write('1\n');
    expect(await p).toBe('a');
    expect(h.stderr_text()).toContain('between 1 and 2');
  });

  it('retries on non-numeric input', async () => {
    const h = harness();
    const p = nonTtySelect<string>(
      {
        message: 'Pick:',
        options: [{ value: 'a', label: 'Alpha' }],
      },
      { reader: h.reader, stdout: h.stdout, stderr: h.stderr },
    );
    h.write('hello\n');
    h.write('1\n');
    expect(await p).toBe('a');
  });

  it('returns CANCEL on EOF', async () => {
    const h = harness();
    const p = nonTtySelect<string>(
      { message: 'Pick:', options: [{ value: 'a', label: 'Alpha' }] },
      { reader: h.reader, stdout: h.stdout, stderr: h.stderr },
    );
    h.end();
    expect(await p).toBe(CANCEL);
  });

  it('throws when options list is empty (no infinite loop)', async () => {
    const h = harness();
    await expect(
      nonTtySelect<string>(
        { message: 'Pick:', options: [] },
        { reader: h.reader, stdout: h.stdout, stderr: h.stderr },
      ),
    ).rejects.toThrow(/No options available/);
  });
});

describe('nonTtyConfirm', () => {
  it('returns true for "y"', async () => {
    const h = harness();
    const p = nonTtyConfirm({ message: 'OK?' }, { reader: h.reader, stderr: h.stderr });
    h.write('y\n');
    expect(await p).toBe(true);
  });

  it('returns true for "yes"', async () => {
    const h = harness();
    const p = nonTtyConfirm({ message: 'OK?' }, { reader: h.reader, stderr: h.stderr });
    h.write('yes\n');
    expect(await p).toBe(true);
  });

  it('returns false for "n"', async () => {
    const h = harness();
    const p = nonTtyConfirm({ message: 'OK?' }, { reader: h.reader, stderr: h.stderr });
    h.write('n\n');
    expect(await p).toBe(false);
  });

  it('uses initialValue on empty input', async () => {
    const h = harness();
    const p = nonTtyConfirm({ message: 'OK?', initialValue: true }, { reader: h.reader, stderr: h.stderr });
    h.write('\n');
    expect(await p).toBe(true);
  });

  it('is case-insensitive', async () => {
    const h = harness();
    const p = nonTtyConfirm({ message: 'OK?' }, { reader: h.reader, stderr: h.stderr });
    h.write('YES\n');
    expect(await p).toBe(true);
  });

  it('retries on unrecognized input', async () => {
    const h = harness();
    const p = nonTtyConfirm({ message: 'OK?' }, { reader: h.reader, stderr: h.stderr });
    h.write('maybe\n');
    h.write('y\n');
    expect(await p).toBe(true);
    expect(h.stderr_text()).toContain('Please answer y or n');
  });

  it('returns CANCEL on EOF', async () => {
    const h = harness();
    const p = nonTtyConfirm({ message: 'OK?' }, { reader: h.reader, stderr: h.stderr });
    h.end();
    expect(await p).toBe(CANCEL);
  });
});

describe('isCancel', () => {
  it('recognizes our CANCEL symbol', () => {
    expect(isCancel(CANCEL)).toBe(true);
  });

  it('returns false for regular values', () => {
    expect(isCancel('hello')).toBe(false);
    expect(isCancel(42)).toBe(false);
    expect(isCancel(null)).toBe(false);
  });
});

describe('multiple prompts sharing one readline interface', () => {
  it('consumes sequential lines from the same pipe', async () => {
    const h = harness();
    const p1 = nonTtyText({ message: 'First?' }, { reader: h.reader, stderr: h.stderr });
    h.write('one\n');
    expect(await p1).toBe('one');

    const p2 = nonTtyText({ message: 'Second?' }, { reader: h.reader, stderr: h.stderr });
    h.write('two\n');
    expect(await p2).toBe('two');

    const p3 = nonTtySelect<string>(
      { message: 'Third?', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] },
      { reader: h.reader, stdout: h.stdout, stderr: h.stderr },
    );
    h.write('2\n');
    expect(await p3).toBe('y');
  });

  it('handles buffered multi-line input written at once', async () => {
    const h = harness();
    h.write('alpha\nbeta\n');

    const p1 = nonTtyText({ message: 'A?' }, { reader: h.reader, stderr: h.stderr });
    expect(await p1).toBe('alpha');

    const p2 = nonTtyText({ message: 'B?' }, { reader: h.reader, stderr: h.stderr });
    expect(await p2).toBe('beta');
  });
});
