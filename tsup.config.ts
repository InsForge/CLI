import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: true,
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  define: {
    'process.env.POSTHOG_API_KEY': JSON.stringify(process.env.POSTHOG_API_KEY || ''),
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
  },
  loader: {
    // Static templates (e.g. PostHog SDK snippets) are imported as raw text
    // and embedded into the bundle so they ship inside dist/index.js without
    // needing a separate asset-copy step.
    '.txt': 'text',
  },
});
