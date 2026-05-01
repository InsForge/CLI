import { readFileSync, cpSync, existsSync, statSync } from 'node:fs';
import { sep } from 'node:path';
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
  // Auth provider scaffolds (lib/auth.ts, route handlers, sql, scripts) are
  // shipped as raw assets — applyAuthProvider() reads them at runtime via
  // import.meta.url. Keep the directory layout identical between src/ and
  // dist/. We only copy contents UNDER `files/` directories — manifest.ts and
  // apply.ts are TS source code that's already bundled into dist/index.js.
  onSuccess: async () => {
    const src = 'src/auth-providers';
    const dest = 'dist/auth-providers';
    if (existsSync(src)) {
      cpSync(src, dest, {
        recursive: true,
        filter: (s) => {
          // Always keep directories so children can be filtered individually.
          if (statSync(s).isDirectory()) return true;
          // Anything inside a `files/` segment is a raw template asset — ship it.
          if (s.includes(`${sep}files${sep}`)) return true;
          // Otherwise it's TS source code (manifest.ts, apply.ts) — drop it.
          return false;
        },
      });
    }
  },
});
