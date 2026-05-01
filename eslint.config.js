import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Enforce consistent style
      'no-console': 'off',
      'prefer-const': 'error',
      'no-var': 'error',
      'eqeqeq': ['error', 'always'],
      'curly': ['error', 'multi-line'],
      'no-throw-literal': 'error',

      // TypeScript specific
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
      }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Allow empty catch blocks (used intentionally in fallbacks)
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // Auth-provider scaffold files are raw template assets shipped to the
    // user's project, not CLI source — they're never imported here, just
    // copied. Skip linting them; they have their own runtime context.
    ignores: ['dist/', 'node_modules/', 'bin/', '*.config.*', 'src/auth-providers/*/files/'],
  },
);
