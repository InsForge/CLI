import * as readline from 'node:readline';
import * as clack from '@clack/prompts';

export const isInteractive = !!(process.stdin.isTTY && process.stdout.isTTY);

/**
 * A line reader that buffers parsed lines and exposes a pull-based readLine API.
 *
 * readline.promises.question() loses 'line' events that fire between question() calls,
 * and does not reject cleanly on stream close. A buffered queue handles both.
 */
export class LineReader {
  private queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private closed = false;
  private rl: readline.Interface;

  constructor(
    input: NodeJS.ReadableStream,
    private output: NodeJS.WritableStream,
  ) {
    this.rl = readline.createInterface({ input });
    this.rl.on('line', (line) => {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(line);
      } else {
        this.queue.push(line);
      }
    });
    this.rl.on('close', () => {
      this.closed = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(null);
      }
    });
  }

  async readLine(prompt: string): Promise<string | null> {
    this.output.write(prompt);
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.closed) return null;
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    this.rl.close();
  }
}

let sharedReader: LineReader | null = null;
function getReader(): LineReader {
  if (!sharedReader) {
    sharedReader = new LineReader(process.stdin, process.stdout);
  }
  return sharedReader;
}

export const CANCEL: unique symbol = Symbol('prompt.cancel');
export type CancelSymbol = typeof CANCEL;

export function isCancel<T>(v: T | CancelSymbol): v is CancelSymbol {
  return v === CANCEL || clack.isCancel(v);
}

export interface TextOptions {
  message: string;
  initialValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | undefined;
}

export interface SelectOption<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface SelectOptions<T> {
  message: string;
  options: SelectOption<T>[];
  initialValue?: T;
}

export interface ConfirmOptions {
  message: string;
  initialValue?: boolean;
}

export async function text(opts: TextOptions): Promise<string | CancelSymbol> {
  if (isInteractive) {
    const result = await clack.text({
      message: opts.message,
      initialValue: opts.initialValue,
      placeholder: opts.placeholder,
      validate: opts.validate,
    });
    if (clack.isCancel(result)) return CANCEL;
    return result;
  }
  return nonTtyText(opts);
}

export async function select<T>(opts: SelectOptions<T>): Promise<T | CancelSymbol> {
  if (isInteractive) {
    const result = await clack.select({
      message: opts.message,
      options: opts.options as { value: T; label: string; hint?: string }[],
      initialValue: opts.initialValue,
    });
    if (clack.isCancel(result)) return CANCEL;
    return result as T;
  }
  return nonTtySelect(opts);
}

export async function confirm(opts: ConfirmOptions): Promise<boolean | CancelSymbol> {
  if (isInteractive) {
    const result = await clack.confirm({
      message: opts.message,
      initialValue: opts.initialValue,
    });
    if (clack.isCancel(result)) return CANCEL;
    return result;
  }
  return nonTtyConfirm(opts);
}

export async function password(opts: { message: string }): Promise<string | CancelSymbol> {
  if (isInteractive) {
    const result = await clack.password({ message: opts.message });
    if (clack.isCancel(result)) return CANCEL;
    return result;
  }
  // Non-TTY: can't mask input over a pipe, just read it
  return nonTtyText({ message: opts.message });
}

export async function nonTtyText(
  opts: TextOptions,
  io: { reader?: LineReader; stderr?: NodeJS.WritableStream } = {},
): Promise<string | CancelSymbol> {
  const reader = io.reader ?? getReader();
  const stderr = io.stderr ?? process.stderr;
  const defaultHint = opts.initialValue ? ` [${opts.initialValue}]` : '';
  for (;;) {
    const raw = await reader.readLine(`? ${opts.message}${defaultHint} `);
    if (raw === null) return CANCEL;
    const value = raw.trim() === '' ? (opts.initialValue ?? '') : raw.trim();
    if (opts.validate) {
      const err = opts.validate(value);
      if (err) {
        stderr.write(`  ${err}\n`);
        continue;
      }
    }
    return value;
  }
}

export async function nonTtySelect<T>(
  opts: SelectOptions<T>,
  io: { reader?: LineReader; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream } = {},
): Promise<T | CancelSymbol> {
  const reader = io.reader ?? getReader();
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  stdout.write(`? ${opts.message}\n`);
  opts.options.forEach((o, i) => {
    const hint = o.hint ? ` — ${o.hint}` : '';
    stdout.write(`  ${i + 1}) ${o.label}${hint}\n`);
  });
  for (;;) {
    const raw = await reader.readLine(`Enter number [1-${opts.options.length}]: `);
    if (raw === null) return CANCEL;
    const n = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= opts.options.length) {
      return opts.options[n - 1].value;
    }
    stderr.write(`  Please enter a number between 1 and ${opts.options.length}.\n`);
  }
}

export async function nonTtyConfirm(
  opts: ConfirmOptions,
  io: { reader?: LineReader; stderr?: NodeJS.WritableStream } = {},
): Promise<boolean | CancelSymbol> {
  const reader = io.reader ?? getReader();
  const stderr = io.stderr ?? process.stderr;
  const defaultHint = opts.initialValue === true ? ' [Y/n]' : opts.initialValue === false ? ' [y/N]' : ' [y/n]';
  for (;;) {
    const raw = await reader.readLine(`? ${opts.message}${defaultHint} `);
    if (raw === null) return CANCEL;
    const answer = raw.trim().toLowerCase();
    if (answer === '' && opts.initialValue !== undefined) return opts.initialValue;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    stderr.write(`  Please answer y or n.\n`);
  }
}
