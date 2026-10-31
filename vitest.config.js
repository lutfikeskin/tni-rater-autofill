// The panel's React component tests (test/**/*.test.jsx), run by `npm test` after the node:test
// files: rendered in jsdom with Testing Library. The node:test files (test/*.test.mjs) stay on
// node --test; Vitest doesn't run them.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.jsx'],
    environment: 'jsdom',
  },
});
