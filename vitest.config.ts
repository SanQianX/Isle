import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    root: rootDir,
    // Node is the default; component tests opt into jsdom with a
    // `@vitest-environment jsdom` docblock rather than a glob split, so the
    // choice is visible in the file that needs it.
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Never let an unhandled rejection silently pass: it means a swallowed
    // error somewhere in the server code.
    dangerouslyIgnoreUnhandledErrors: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/lib/**', 'src/server/**', 'src/features/**'],
    },
  },
});
