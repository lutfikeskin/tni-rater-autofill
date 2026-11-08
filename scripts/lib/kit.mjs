// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
// The fill engine injected into carrier pages (__raterKit) is built from its source under src/kit/
// into one classic script: an IIFE with no imports, as chrome.scripting.executeScript needs. The
// extension injects it as src/content/pagekit.js, the path the package writes it to; the
// repository has no file there. Everything that runs the kit builds it here: the package, the
// tests, the mocks, the replay server and the panel preview.
//
// Nothing is minified or shaken out, and nothing is lowered (target esnext): the build only joins
// the modules and prints the code again, so the kit behaves as its source reads. The source map
// points back to src/kit/.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const KIT_ENTRY = 'src/kit/pagekit.js';
// Where the extension finds the built kit (sidepanel/panel/fill.js injects it).
export const KIT_OUTPUT = 'src/content/pagekit.js';

// { code, map }: code ends with a sourceMappingURL to `${KIT_OUTPUT}.map`'s name; map is the
// source map's JSON text, its sources relative to the output's folder.
export async function buildKit() {
  const out = await build({
    cwd: root,
    input: path.join(root, KIT_ENTRY),
    write: false,
    logLevel: 'warn',
    treeshake: false,
    transform: { target: 'esnext' },
    output: { format: 'iife', sourcemap: true, minify: false, file: path.join(root, KIT_OUTPUT) },
  });
  const chunk = out.output.find((o) => o.type === 'chunk');
  const map = out.output.find((o) => o.type === 'asset' && o.fileName.endsWith('.map'));
  if (!chunk || out.output.filter((o) => o.type === 'chunk').length !== 1) throw new Error('the kit must build into one script');
  return { code: chunk.code, map: map ? String(map.source) : JSON.stringify(chunk.map) };
}

// The kit's code, built once per process (tests and mocks load it many times).
let built = null;
export const kitCode = async () => (await (built ??= buildKit())).code;
