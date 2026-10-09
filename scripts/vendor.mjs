#!/usr/bin/env node
// Copies the third-party code the extension loads into lib/ (committed, so the extension needs no
// build step): PDF.js as published, and the Anthropic SDK bundled into one ES module, since an
// extension page can't resolve the package names its files import. Both versions are pinned
// exactly in package.json; rerun this after changing either.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
fs.mkdirSync(new URL('lib/', root), { recursive: true });
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  fs.copyFileSync(new URL(`node_modules/pdfjs-dist/build/${file}`, root), new URL(`lib/${file}`, root));
}

// Only what src/ai/claude.js imports: the client and the error classes it tells apart.
const sdk = JSON.parse(fs.readFileSync(new URL('node_modules/@anthropic-ai/sdk/package.json', root), 'utf8'));
const outfile = fileURLToPath(new URL('lib/anthropic-sdk.mjs', root));
const result = await build({
  stdin: {
    contents: "export { default, APIError, APIUserAbortError, APIConnectionError } from '@anthropic-ai/sdk';",
    resolveDir: fileURLToPath(root),
    loader: 'js',
  },
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome140', minify: true, legalComments: 'eof', metafile: true,
  banner: { js: `// @anthropic-ai/sdk ${sdk.version}, bundled by scripts/vendor.mjs; licenses of every bundled package at the end.` },
  outfile,
});
// The license of each package in the bundle (their files carry none of it themselves).
const packages = [...new Set(Object.keys(result.metafile.inputs)
  .map((p) => p.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean))].sort();
const notices = packages.map((name) => {
  const dir = new URL(`node_modules/${name}/`, root);
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', dir), 'utf8'));
  const file = fs.readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
  const text = file ? fs.readFileSync(new URL(file, dir), 'utf8').trim() : `${pkg.license} (the package ships no license file).`;
  return `${name} ${pkg.version} (${pkg.license})\n\n${text}`;
});
fs.appendFileSync(outfile, `\n/*\n${notices.join('\n\n---\n\n').replaceAll('*/', '* /')}\n*/\n`);
console.log(`Updated lib/: PDF.js (two files) and the Anthropic SDK ${sdk.version} (anthropic-sdk.mjs).`);
