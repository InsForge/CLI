import { readFileSync } from 'node:fs';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const CURSOR_HOME = '\x1b[H';
const CLEAR_SCREEN = '\x1b[2J';
const RESET = '\x1b[0m';
const FORGER_ASSET_URL = new URL('./assets/forger.json', import.meta.url);

type Frame = {
  duration?: number;
  content: string[];
  colors?: {
    foreground?: string;
  };
};

type AnimationFile = {
  canvas: {
    width: number;
    height: number;
  };
  animation?: {
    frameRate?: number;
  };
  frames: Frame[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function buildFrameLines(
  frame: Frame,
  width: number,
  height: number,
  colorCache: Map<string, [number, number, number]>,
): string[] {
  const foreground = frame.colors?.foreground ? (JSON.parse(frame.colors.foreground) as Record<string, string>) : {};
  const lines: string[] = [];

  for (let row = 0; row < height; row++) {
    let line = row < frame.content.length ? frame.content[row] : '';
    if (line.length < width) {
      line = line + ' '.repeat(width - line.length);
    } else if (line.length > width) {
      line = line.slice(0, width);
    }

    const rendered: string[] = [];
    let currentColor: string | null = null;

    for (let col = 0; col < line.length; col++) {
      const char = line[col];
      const colorHex = foreground[`${col},${row}`] ?? null;
      if (colorHex !== currentColor) {
        if (colorHex === null) {
          rendered.push(RESET);
        } else {
          const cached = colorCache.get(colorHex);
          const rgb = cached ?? hexToRgb(colorHex);
          if (!cached) colorCache.set(colorHex, rgb);
          rendered.push(`\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`);
        }
        currentColor = colorHex;
      }
      rendered.push(char);
    }

    rendered.push(RESET);
    lines.push(rendered.join(''));
  }

  return lines;
}

export async function playForgerAnimation(): Promise<void> {
  if (!process.stdout.isTTY) return;

  const animation = JSON.parse(readFileSync(FORGER_ASSET_URL, 'utf-8')) as AnimationFile;
  const width = animation.canvas.width;
  const height = animation.canvas.height;
  const fallbackDuration = 1000 / (animation.animation?.frameRate ?? 30);
  const colorCache = new Map<string, [number, number, number]>();

  const renderedFrames = animation.frames.map((frame) => ({
    lines: buildFrameLines(frame, width, height, colorCache),
    delayMs: frame.duration ?? fallbackDuration,
  }));

  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR_SCREEN + CURSOR_HOME);
  try {
    for (const frame of renderedFrames) {
      process.stdout.write(CURSOR_HOME);
      process.stdout.write(frame.lines.join('\n'));
      await sleep(Math.max(frame.delayMs, 0));
    }
  } finally {
    process.stdout.write(RESET + SHOW_CURSOR + ALT_SCREEN_OFF);
  }
}
