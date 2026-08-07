import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };
const outDir = 'dist';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  outDir,
  clean: true,
  sourcemap: process.env.CI !== 'true',
  dts: true,
  splitting: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
  define: {
    'process.env.POSTHOG_API_KEY': JSON.stringify(process.env.POSTHOG_API_KEY || ''),
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
  },
  esbuildPlugins: [
    {
      name: 'copy-assets',
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length > 0) return;

          const assetsDir = join(outDir, 'assets');
          mkdirSync(assetsDir, { recursive: true });
          copyFileSync('src/assets/forger.json', join(assetsDir, 'forger.json'));

          // Compose files for `insforge local start`. They reference only
          // published images and named volumes, so they run correctly from
          // inside the installed package.
          const localDir = join(assetsDir, 'local');
          mkdirSync(localDir, { recursive: true });
          for (const file of [
              // The stack comes from InsForge's repository via its setup.sh. The
              // only compose the CLI ships is the overlay carrying the telemetry
              // stamp — see src/lib/local/checkout.ts.
              'cli-overlay.yml',
          ]) {
            copyFileSync(join('src/assets/local', file), join(localDir, file));
          }
        });
      },
    },
  ],
});
