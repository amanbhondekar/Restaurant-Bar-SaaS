import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// The frontend test runner. Kept apart from vite.config.js so the production build is untouched by
// it, and so tests skip Tailwind: what they check is behaviour and what a person can read, not
// styling. The hub has its own suite under hub_server/test, run with node --test.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/test/**/*.test.{js,jsx}'],
    setupFiles: ['src/test/setup.js'],
    css: false,
    // Each file gets a fresh DOM and fresh module state, so one surface's fetch stub or URL can
    // never leak into another's.
    isolate: true,
    restoreMocks: true,
  },
});
