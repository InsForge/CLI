// Static PostHog SDK setup templates per supported framework.
//
// Each template is a `.txt` file (so it reviews cleanly without TS escaping)
// embedded into the bundle via tsup's `text` loader (see tsup.config.ts).
// Variables use `{{KEY}}` placeholders; substitute via `renderTemplate()`.

import nextAppProvider from './next-app/posthog-provider.tsx.txt';
import nextAppLayoutSnippet from './next-app/layout-snippet.tsx.txt';
import nextPagesApp from './next-pages/_app.tsx.txt';
import viteReactMainSnippet from './vite-react/main-snippet.tsx.txt';
import sveltekitHooks from './sveltekit/hooks.client.ts.txt';

export const templates = {
  'next-app': {
    provider: nextAppProvider,
    layoutSnippet: nextAppLayoutSnippet,
  },
  'next-pages': {
    app: nextPagesApp,
  },
  'vite-react': {
    mainSnippet: viteReactMainSnippet,
  },
  sveltekit: {
    hooks: sveltekitHooks,
  },
} as const;

export function renderTemplate(
  raw: string,
  vars: Record<string, string>,
): string {
  return raw.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
}
