import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next@15.5.28 still ships the legacy eslintrc format, so bridge it
// into flat config via FlatCompat. Pinned major (eslint 9) is required by that
// package's peer range — see ADR-013.
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'coverage/**',
      'src/generated/**',
      'next-env.d.ts',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // Core function rejects unexplained `any` (MASTER_PLAN §D).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Photographs are rendered with a plain <img>, not next/image.
    // next/image re-encodes through its optimizer, which would mean the bytes a
    // visitor sees are not the bytes that were uploaded -- the one thing this
    // project must never do (DATA_API_STORAGE §3). We do our own derivation at
    // upload time and serve those files unchanged, and we reserve layout space
    // with explicit width/height so there is no CLS.
    files: ['src/app/**/*.tsx', 'src/components/**/*.tsx'],
    rules: {
      '@next/next/no-img-element': 'off',
    },
  },
  {
    // Test and script files legitimately use Node globals and looser casts.
    files: [
      'tests/**/*.{ts,tsx}',
      'e2e/**/*.{ts,tsx}',
      'scripts/**/*.{ts,mjs}',
      '*.config.{ts,mts}',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];

export default config;
