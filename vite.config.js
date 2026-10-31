// The side panel's build: sidepanel/sidepanel.html and everything it imports (the panel, src/, the
// vendored PDF.js) bundled into one page for the extension. Only the panel is built; the manifest,
// background.js and the scripts injected into carrier pages are packaged as they are.
//
//   npm run package       -> builds the panel into each packaged copy (scripts/package.mjs)
//   npm run panel         -> rebuilds the panel in dist/tni-rater-autofill (after one npm run package)
//   npm run panel:watch   -> the same on every save; reload the panel to see it
//   npm run preview       -> the panel beside a practice carrier page, on Vite's dev server (preview/)
//
// The extension itself can't load from a dev server, so the packaged copies are built. Files keep
// fixed names (no content hash), so a rebuild into the same folder replaces them instead of leaving
// old ones behind.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { packagedCommit, provenancePlugin } from './scripts/lib/package.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// In the preview only: the panel page gets preview/panel-shim.js before its own code, so it runs
// against the preview's chrome.* stand-in (preview/preview.js). Never in a build.
const previewShim = {
  name: 'tni-preview-shim',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const { pathname } = new URL(req.url, 'http://preview');
      // The server's address opens the preview.
      if (pathname === '/') {
        res.statusCode = 302;
        res.setHeader('Location', '/preview/');
        return res.end();
      }
      // The preview page and the practice carrier pages as they are, without Vite's client: after
      // an edit only the panel reloads, and the preview keeps what the panel stored.
      const file = pathname === '/preview/' ? 'preview/index.html' : /^\/test\/.+\.html$/.test(pathname) ? decodeURIComponent(pathname.slice(1)) : null;
      if (!file) return next();
      fs.readFile(path.join(here, file), (error, html) => {
        if (error) return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
      });
    });
  },
  transformIndexHtml(html, ctx) {
    if (ctx.path !== '/sidepanel/sidepanel.html') return html;
    return [{ tag: 'script', attrs: { src: '/preview/panel-shim.js' }, injectTo: 'head-prepend' }];
  },
};

// Every build stamps the panel's usage-log.js with its copy and commit: `store` for the store zip
// (npm run package builds in that mode), otherwise `unpacked` (the Load unpacked copy, also when
// npm run panel rebuilds it).
export default defineConfig(({ command, mode }) => ({
  // The dev server serves the repository, as the extension does, so the panel's src/ imports, the
  // page scripts it injects and the practice carrier pages (test/fixtures/) share one origin.
  root: command === 'serve' ? here : path.join(here, 'sidepanel'),
  base: './',
  // The sounds, logos and rater badges the panel names at run time are copied by package.mjs.
  publicDir: false,
  plugins: [react(), previewShim, ...(command === 'build' ? [provenancePlugin({ channel: mode === 'store' ? 'store' : 'unpacked', commit: packagedCommit(here) })] : [])],
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    watch: { ignored: ['**/dist/**', '**/layouts/**', '**/server-data/**', '**/reviews/**', '**/captures/**'] },
  },
  optimizeDeps: { entries: ['preview/index.html', 'sidepanel/sidepanel.html'] },
  build: {
    outDir: path.join(here, 'dist/tni-rater-autofill/sidepanel'),
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
      input: path.join(here, 'sidepanel/sidepanel.html'),
      output: {
        entryFileNames: 'bundle/[name].js',
        chunkFileNames: 'bundle/[name].js',
        assetFileNames: 'bundle/[name][extname]',
      },
    },
  },
}));
