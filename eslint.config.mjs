// Root ESLint flat config — TypeScript strict + architectural boundaries.
// Boundary rules mirror docs/system-architecture.md §2 (import rules).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

const ROOT = import.meta.dirname;

// Application TypeScript projects (source of truth for type-aware linting).
const APP_PROJECTS = ['shared/tsconfig.json', 'backend/tsconfig.json', 'frontend/tsconfig.json'];
// Test files live in a separate noEmit project so the build output stays clean.
// `frontend/tsconfig.json` already includes `src/**` (tests are typechecked and never emitted),
// so it doubles as the frontend test project.
const TEST_PROJECTS = [
  'shared/tsconfig.test.json',
  'backend/tsconfig.test.json',
  'frontend/tsconfig.json',
  'database/tsconfig.json',
];

const PURE_BOUNDARY = [
  'error',
  {
    patterns: [
      {
        group: ['express', 'pg', 'node:**', 'fs', 'path', 'http', 'crypto', 'dotenv'],
        message:
          'Domain/contract code must stay framework- and platform-free (system-architecture.md §2).',
      },
    ],
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'evidence/**',
      'docs/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // ---------- Plain JavaScript (docker helpers, database migrations/seeds) ----------
  {
    files: ['**/*.{js,cjs,mjs}'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },

  // ---------- TypeScript, all packages ----------
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { project: APP_PROJECTS, tsconfigRootDir: ROOT },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'object-shorthand': 'error',
      'prefer-const': 'error',
    },
  },

  // ---------- Test files use the noEmit test project ----------
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/test/**/*.{ts,tsx}', '**/vitest.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { project: TEST_PROJECTS, tsconfigRootDir: ROOT },
    },
    rules: {
      /**
       * Supertest types `response.body` as `any`, so member access inside assertions would be
       * "unsafe" by the letter of the rule. Every payload assertion in these tests goes through a
       * Zod schema from `@esrs/shared` (contract tests C-01/C-02), which is the real guarantee.
       */
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      /**
       * Test doubles implement async ports (`fetch`, repositories, clocks) and are frequently
       * `async` purely to satisfy that signature; requiring an `await` inside them would force
       * meaningless `await Promise.resolve()` noise into the fixtures.
       */
      '@typescript-eslint/require-await': 'off',
    },
  },

  // ---------- Contract package: usable from browser AND Node ----------
  { files: ['shared/**/*.ts'], rules: { 'no-restricted-imports': PURE_BOUNDARY } },

  // ---------- Backend domain core: pure functions, no I/O ----------
  { files: ['backend/src/domain/**/*.ts'], rules: { 'no-restricted-imports': PURE_BOUNDARY } },

  // ---------- Backend modules talk to each other through services, not repositories ----------
  {
    files: ['backend/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Cross-module imports use `../<module>/<file>.js`; a module may import its own
              // repository as `./<name>.repository.js`, so only the `../` shape is banned here.
              group: ['../*/*.repository.js', '../*/*/*.repository.js'],
              message: 'Cross-module repository imports are forbidden; call the other service.',
            },
          ],
        },
      ],
    },
  },

  // ---------- Frontend ----------
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@esrs/backend/*', 'backend/**'],
              message: 'Frontend may import @esrs/shared only (system-architecture.md §2).',
            },
          ],
        },
      ],
    },
  },

  prettierConfig,
);
