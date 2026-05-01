// Manifest for the Better Auth integration. Used by applyAuthProvider() to
// know which files to drop, which package.json fields to deep-merge, and
// what to append to .env.example. Files referenced here are read at runtime
// from the sibling files/ directory (copied to dist/ at build time).

export const manifest = {
  name: 'better-auth',
  // Files copied verbatim from files/ into the project. Skipped if a file
  // already exists at the same path (overlay-safe by default).
  files: [
    'lib/auth.ts',
    'lib/auth-client.ts',
    'lib/insforge.ts',
    'lib/insforge.server.ts',
    'lib/insforge-server-mailer.ts',
    'app/api/auth/[...all]/route.ts',
    'app/api/insforge-token/route.ts',
    'app/notes/page.tsx',
    'app/sign-in/page.tsx',
    'app/sign-up/page.tsx',
    'sql/01-init.sql',
    'sql/02-revoke.sql',
    'scripts/setup-db.mjs',
  ],
  // Deep-merged into the user's package.json (existing keys win for
  // dependencies/devDependencies; scripts likewise — the user's own
  // auth:migrate is preserved if they happen to have one).
  packageJsonPatch: {
    dependencies: {
      '@insforge/sdk': '^1.2.6',
      'better-auth': '^1.6.0',
      'jsonwebtoken': '^9.0.2',
      'pg': '^8.13.0',
    },
    devDependencies: {
      '@better-auth/cli': '^1.4.21',
      '@types/jsonwebtoken': '^9.0.8',
      '@types/pg': '^8.11.10',
    },
    scripts: {
      'auth:migrate': 'better-auth migrate --config ./lib/auth.ts -y',
      'db:setup': 'node --env-file=.env.local scripts/setup-db.mjs',
      'setup': 'npm run auth:migrate && npm run db:setup',
    },
  },
  // Appended to .env.example (with a leading separator). The CLI's regular
  // env-fill loop processes these the same as base-template vars, so
  // INSFORGE_JWT_SECRET / BETTER_AUTH_SECRET / NEXT_PUBLIC_INSFORGE_BASE_URL
  // get auto-populated.
  envExampleAppend: `
# ─── Better Auth + InsForge bridge (added by --auth better-auth) ────────
# Postgres for BA's own user/session/account/verification tables.
# Self-hosted: your InsForge stack's Postgres (use a fully-granted role).
# Cloud: bring your own Postgres — InsForge cloud doesn't expose direct DB.
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/insforge

BETTER_AUTH_SECRET=replace-with-32-random-bytes
BETTER_AUTH_URL=http://localhost:3000
NEXT_PUBLIC_BETTER_AUTH_URL=http://localhost:3000

# Same secret InsForge uses internally; the bridge route signs HS256 with this.
INSFORGE_JWT_SECRET=replace-with-output-of-cli-secrets-get-JWT_SECRET
NEXT_PUBLIC_INSFORGE_BASE_URL=http://localhost:7130
NEXT_PUBLIC_INSFORGE_ANON_KEY=replace-with-anon-key-from-insforge-dashboard
`.trim(),
  // Printed to the user after applyAuthProvider() finishes.
  nextSteps: `Better Auth scaffold installed. Next:

  1. Set DATABASE_URL in .env.local (where Better Auth's tables will live).
  2. npm install
  3. npm run setup     # runs BA migrations + RLS helper + REVOKE block
  4. npm run dev       # then open http://localhost:3000/sign-up`,
};

export type AuthProviderManifest = typeof manifest;
