import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STAMPED, buildId, stampBuild, DEV_KEY, DEV_EXTENSION_ID, devManifest, extensionId, PROVENANCE_FILE, stampProvenance, provenancePlugin, bundledPanelFile } from '../scripts/lib/package.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the page scripts are stamped with a build that follows their content', () => {
  const texts = STAMPED.map(read);
  const build = buildId(texts);
  assert.match(build, /^[0-9a-f]{12}$/);
  assert.equal(buildId(texts), build, 'the same files, the same build');
  assert.notEqual(buildId([texts[0], `${texts[1]}\n`]), build, 'any change, another build');
  for (const text of texts) {
    const stamped = stampBuild(text, build);
    assert.ok(stamped.includes(`const BUILD = '${build}';`));
    assert.ok(!stamped.includes("const BUILD = 'source';"));
  }
  assert.throws(() => stampBuild('no placeholder here', build));
});

// Audit 2026-10-08: events from development copies said only "0.9.8", like the release.
test('usage events name the copy and commit they come from: store, unpacked, or the repository itself', () => {
  const text = read(PROVENANCE_FILE);
  assert.ok(text.includes("const PROVENANCE = { channel: 'source', commit: null };"), 'the repository runs as source, no commit');
  assert.ok(stampProvenance(text, { channel: 'store', commit: '7a5cdb5244' }).includes("const PROVENANCE = { channel: 'store', commit: '7a5cdb5244' };"));
  assert.ok(stampProvenance(text, { channel: 'unpacked', commit: '7a5cdb5244+dirty' }).includes("{ channel: 'unpacked', commit: '7a5cdb5244+dirty' }"));
  assert.ok(stampProvenance(text, { channel: 'unpacked', commit: null }).includes("{ channel: 'unpacked', commit: null }"), 'packaged without git');
  assert.throws(() => stampProvenance(text, { channel: 'beta', commit: null }));
  assert.throws(() => stampProvenance(text, { channel: 'store', commit: "x'; alert(1); '" }));
  assert.throws(() => stampProvenance('no placeholder', { channel: 'store', commit: null }));
});

// The panel is bundled since 2026-10-31: usage-log.js is stamped as the build reads it, not as a file.
test('the panel build stamps usage-log.js, and fails if the build never read it', () => {
  const plugin = provenancePlugin({ channel: 'store', commit: '7a5cdb5244' });
  assert.equal(plugin.enforce, 'pre', 'before Vite reformats the file');
  assert.equal(plugin.transform('const x = 1;', 'C:\\repo\\sidepanel\\panel\\core.js'), null, 'other files as they are');
  const out = plugin.transform(read(PROVENANCE_FILE), 'C:\\repo\\sidepanel\\usage-log.js');
  assert.ok(out.code.includes("const PROVENANCE = { channel: 'store', commit: '7a5cdb5244' };"), 'Windows paths too');
  plugin.buildEnd();
  assert.throws(() => provenancePlugin({ channel: 'store', commit: null }).buildEnd(), /usage-log\.js/);
  assert.doesNotThrow(() => provenancePlugin({ channel: 'store', commit: null }).buildEnd(new Error('build failed')), 'the build\'s own error is the one reported');
});

test('the package leaves out the panel files the build bundles, and keeps its sounds and images', () => {
  for (const f of ['sidepanel/sidepanel.html', 'sidepanel/sidepanel.css', 'sidepanel/usage-log.js', 'sidepanel/panel/core.js', 'sidepanel\\panel\\fill.js']) assert.ok(bundledPanelFile(f), f);
  for (const f of ['sidepanel/sounds/quote-done.mp3', 'sidepanel/assets/raters/geico.gif', 'sidepanel/logo.png', 'src/content/pagekit.js', 'background.js', 'lib/pdf.min.mjs']) assert.ok(!bundledPanelFile(f), f);
});

test('the unpacked copy has a fixed extension ID; the store manifest stays without a key', () => {
  assert.equal(extensionId(DEV_KEY), DEV_EXTENSION_ID);
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.key, undefined, 'the Chrome Web Store refuses a manifest with a key');
  const dev = devManifest(manifest);
  assert.equal(dev.key, DEV_KEY);
  assert.equal(manifest.key, undefined, 'the original is left as it is');
  assert.equal(dev.version, manifest.version);
});

// The type check's types (types.js, at the root) are outside the package: code put there, or a
// module importing it as code rather than in a JSDoc type, would be missing from the extension.
test('the type check\'s types hold comments only, and no module of the extension imports them', () => {
  const commentsOnly = (text) => {
    for (let i = 0; i < text.length;) {
      if (/\s/.test(text[i])) i++;
      else if (text.startsWith('//', i)) i = text.includes('\n', i) ? text.indexOf('\n', i) : text.length;
      else if (text.startsWith('/*', i) && text.includes('*/', i + 2)) i = text.indexOf('*/', i + 2) + 2;
      else return false;
    }
    return true;
  };
  assert.ok(commentsOnly(read('types.js')), 'types.js holds code');
  assert.ok(!commentsOnly('/** @typedef {object} T */\nexport {};'));
  const modules = (dir) => fs.readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true })
    .filter((f) => /\.m?js$/.test(f)).map((f) => `${dir}/${f.replaceAll('\\', '/')}`);
  // A static import or re-export, a bare import, or import() as code, in any quotes; a JSDoc
  // `@import` or `import('./types.js').SomeType` is a comment. The file is `types.js` itself, not a
  // module whose name ends in it.
  const IMPORTS_TYPES = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*(['"])(?:[^'"\n]*\/)?types\.js\1|^\s*import\s*(['"])(?:[^'"\n]*\/)?types\.js\2|\bimport\(\s*(['"`])(?:[^'"`\n]*\/)?types\.js\3\s*\)(?!\.[A-Z])/m;
  for (const code of ["export * from './types.js';", "export {\n  A,\n} from '../types.js';", "import x from './types.js';", "import './types.js';", "import('./types.js').then((m) => m);", "await import('./types.js');",
    'import x from "./types.js";', 'import "../types.js";', 'await import("./types.js");', 'await import(`../types.js`);']) {
    assert.match(code, IMPORTS_TYPES, code);
  }
  for (const doc of ["/** @import { A, B } from './types.js' */", " * @param {import('../types.js').FillReport} r", "/** @type {import('./types.js').CarrierConfig} */",
    "import { list } from './unit-types.js';", 'import x from "./prototypes.js";', "await import('./unit-types.js');"]) {
    assert.doesNotMatch(doc, IMPORTS_TYPES, doc);
  }
  for (const f of ['background.js', ...modules('src'), ...modules('sidepanel')]) assert.doesNotMatch(read(f), IMPORTS_TYPES, `${f} imports the types as code`);
});

// Review of #239: npm run panel rebuilt the unpacked copy without the stamp, so its events said 'source'.
test('every panel build stamps its copy: store in store mode, unpacked otherwise, none on the dev server', async () => {
  const { default: config } = await import('../vite.config.js');
  const stampOf = (env) => {
    const plugin = config(env).plugins.flat().find((p) => p?.name === 'tni-provenance');
    return plugin && plugin.transform(read(PROVENANCE_FILE), `/repo/${PROVENANCE_FILE}`).code.match(/channel: '(\w+)'/)[1];
  };
  assert.equal(stampOf({ command: 'build', mode: 'store' }), 'store');
  assert.equal(stampOf({ command: 'build', mode: 'unpacked' }), 'unpacked');
  assert.equal(stampOf({ command: 'build', mode: 'production' }), 'unpacked', 'npm run panel');
  assert.equal(stampOf({ command: 'serve', mode: 'development' }), undefined);
});

// Review of #239: npm run panel:watch read the commit once, so rebuilds after an edit claimed a clean commit.
test('a watch build always says its commit is dirty', () => {
  const stamped = (watchMode, commit) => {
    const plugin = provenancePlugin({ channel: 'unpacked', commit });
    plugin.buildStart.call({ meta: { watchMode } });
    return plugin.transform(read(PROVENANCE_FILE), `/repo/${PROVENANCE_FILE}`).code;
  };
  assert.ok(stamped(true, '7a5cdb5244').includes("commit: '7a5cdb5244+dirty'"));
  assert.ok(stamped(true, '7a5cdb5244+dirty').includes("commit: '7a5cdb5244+dirty'"), 'not twice');
  assert.ok(stamped(true, null).includes('commit: null'), 'packaged without git');
  assert.ok(stamped(false, '7a5cdb5244').includes("commit: '7a5cdb5244'"), 'a one-off build as git says');
});
