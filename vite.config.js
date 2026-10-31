// The side panel's build: sidepanel/sidepanel.html and everything it imports (the panel, src/, the
// vendored PDF.js) bundled into one page for the extension. Only the panel is built; the manifest,
// background.js and the scripts injected into carrier pages are packaged as they are.
//
//   npm run package       -> builds the panel into each packaged copy (scripts/package.mjs)
//   npm run panel         -> rebuilds the panel in dist/tni-rater-autofill (after one npm run package)
//   npm run panel:watch   -> the same on every save; reload the panel to see it
//
// No dev server or HMR: an extension page can't load from one. Files keep fixed names (no content
// hash), so a rebuild into the same folder replaces them instead of leaving old ones behind.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'sidepanel',
  base: './',
  // The sounds, logos and rater badges the panel names at run time are copied by package.mjs.
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: '../dist/tni-rater-autofill/sidepanel',
    emptyOutDir: false,
    // Not minified, with source maps: the bundle reads like the source in DevTools.
    minify: false,
    sourcemap: true,
    target: 'chrome120',
    assetsDir: 'bundle',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      // The page the manifest names (side_panel.default_path), not Vite's index.html.
      input: 'sidepanel/sidepanel.html',
      output: {
        entryFileNames: 'bundle/[name].js',
        chunkFileNames: 'bundle/[name].js',
        assetFileNames: 'bundle/[name][extname]',
      },
    },
  },
});
