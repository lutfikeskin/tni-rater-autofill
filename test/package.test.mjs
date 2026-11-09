// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STAMPED, storeManifest, withoutLocalPages, LOCAL_PAGES_FILE, buildId, stampBuild, DEV_KEY, DEV_EXTENSION_ID, devManifest, extensionId, PROVENANCE_FILE, stampProvenance, provenancePlugin, bundledPanelFile, kitSourceFile, zipName, PACKAGED, mapsZipName, withoutMapUrl, packageOf, noticesPlugin, thirdPartyNotices, RULES_FILE, stampRules, rulesOf, rulesPlugin } from '../scripts/lib/package.mjs';
import { RULE_FILES, rulesHash } from '../src/usage.js';
import { kitCode } from '../scripts/lib/kit.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the page scripts are stamped with a build that follows their content', async () => {
  // field-key.js as it is, and the fill engine as built (scripts/lib/kit.mjs).
  const texts = [...STAMPED.map(read), await kitCode()];
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
  for (const f of ['sidepanel/sidepanel.html', 'sidepanel/sidepanel.css', 'sidepanel/usage-log.js', 'sidepanel/panel/core.js', 'sidepanel\\panel\\fill.js', 'sidepanel/panel/report-view.jsx', 'sidepanel/panel/agent-defaults/view.jsx']) assert.ok(bundledPanelFile(f), f);
  for (const f of ['sidepanel/sounds/quote-done.mp3', 'sidepanel/assets/raters/geico.gif', 'sidepanel/logo.png', 'src/content/pagekit.js', 'background.js', 'lib/pdf.min.mjs']) assert.ok(!bundledPanelFile(f), f);
});

test('the package leaves out the fill engine\'s source, which it builds into src/content/pagekit.js', () => {
  for (const f of ['src/kit', 'src/kit/pagekit.js', 'src\\kit\\pagekit.js']) assert.ok(kitSourceFile(f), f);
  for (const f of ['src/content/pagekit.js', 'src/content/field-key.js', 'src/plan.js', 'src/kits.js']) assert.ok(!kitSourceFile(f), f);
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

// Audit 2026-11-07, QA-17: test builds were zips named by hand (`0.9.28-test-build-5bb6f00.zip`).
// `npm run package -- --label <label>` names one by the script: its label and its commit.
test('a labelled package is named by its version, label and commit; the store zip as before', () => {
  assert.equal(zipName('0.9.32'), 'tni-rater-autofill-0.9.32.zip');
  assert.equal(zipName('0.9.32', { label: 'test-build', commit: '5bb6f00' }), 'tni-rater-autofill-0.9.32-test-build-5bb6f00.zip');
  assert.equal(zipName('0.9.32', { label: 'test-build', commit: '5bb6f00+dirty' }), 'tni-rater-autofill-0.9.32-test-build-5bb6f00-dirty.zip', 'a dirty tree says so');
  assert.equal(zipName('0.9.32', { label: 'test-build' }), 'tni-rater-autofill-0.9.32-test-build-nocommit.zip', 'git couldn\'t say');
  for (const bad of ['', 'Test Build', '../x', 'a_b', 'x'.repeat(41)]) assert.throws(() => zipName('0.9.32', { label: bad }), /lowercase words and hyphens/, JSON.stringify(bad));
  // The script takes it from --label.
  const script = read('scripts/package.mjs');
  assert.match(script, /process\.argv\.indexOf\('--label'\)/);
  assert.match(script, /zipName\(manifest\.version, label == null \? \{\} : \{ label, commit: packagedCommit\(root\) \}\)/);
});

// Audit 2026-11-07, QA-09: the panel fetched the rule files from its own package as it started to
// fingerprint them, and a failure was swallowed, leaving fill_run's `rules` out. The build works it
// out instead, from the same files, and stamps it.
test('the panel build stamps the rules fingerprint of RULE_FILES, and fails if the build never read coordinator.js', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const expected = await rulesHash(RULE_FILES.map(read));
  assert.equal(await rulesOf(root), expected, 'the same fingerprint the panel worked out from the packaged files');
  const plugin = rulesPlugin(root);
  assert.equal(plugin.enforce, 'pre');
  const watched = [];
  const ctx = { addWatchFile: (f) => watched.push(f) };
  assert.equal(await plugin.transform.call(ctx, 'const x = 1;', 'C:\\repo\\sidepanel\\panel\\core.js'), null, 'other files as they are');
  const source = read(RULES_FILE);
  assert.match(source, /^const RULES_VERSION = null;$/m, 'unbuilt, the panel carries none');
  const out = await plugin.transform.call(ctx, source, 'C:\\repo\\sidepanel\\panel\\coordinator.js');
  assert.ok(out.code.includes(`const RULES_VERSION = '${expected}';`), 'Windows paths too');
  assert.equal(watched.length, RULE_FILES.length, 'a watch build stamps it again when a rule file changes');
  plugin.buildEnd();
  assert.throws(() => rulesPlugin(root).buildEnd(), /coordinator\.js/);
  assert.doesNotThrow(() => rulesPlugin(root).buildEnd(new Error('build failed')));
  assert.throws(() => stampRules('no placeholder', expected));
  assert.throws(() => stampRules(source, "x'; alert(1); '"));
  // The panel no longer fetches its own files for it; every build has the plugin, the dev server none.
  assert.doesNotMatch(source, /RULE_FILES\.map|fetch\(chrome\.runtime\.getURL\(f\)\)/);
  const { default: config } = await import('../vite.config.js');
  const has = (env) => config(env).plugins.flat().some((p) => p?.name === 'tni-rules');
  assert.ok(has({ command: 'build', mode: 'store' }) && has({ command: 'build', mode: 'unpacked' }));
  assert.ok(!has({ command: 'serve', mode: 'development' }));
});

// Audit 2026-11-07, QA-09: the store zip carried the source maps (3.7 MB for the panel's alone) and
// lib/, which the panel's build had already taken in, and the licences of the code it bundled only
// in lib/fflate.mjs.
test('the store zip leaves out lib/ and the source maps, and carries the bundled code\'s licences', async () => {
  assert.ok(!PACKAGED.includes('lib'), 'lib/ is bundled into the panel');
  // Only the panel imports lib/, and the panel is bundled: nothing run as it is names it.
  const content = fs.readdirSync(new URL('../src/content/', import.meta.url), { recursive: true }).filter((f) => /\.m?js$/.test(f)).map((f) => `src/content/${f.replaceAll('\\', '/')}`);
  for (const f of ['background.js', ...content]) assert.doesNotMatch(read(f), /lib\/(pdf|fflate)/, `${f} loads lib/ itself`);
  assert.equal(mapsZipName('dist/tni-rater-autofill-0.9.32.zip'), 'dist/tni-rater-autofill-0.9.32-sourcemaps.zip');
  // The fill engine's store copy doesn't name a map it lacks; the panel's store build doesn't either.
  const kit = await kitCode();
  assert.match(kit, /\/\/# sourceMappingURL=/);
  const stripped = withoutMapUrl(kit);
  assert.doesNotMatch(stripped, /sourceMappingURL/);
  assert.ok(stripped.startsWith(kit.slice(0, kit.lastIndexOf('//# sourceMappingURL'))), 'only the last line goes');
  assert.throws(() => withoutMapUrl('const a = 1;\n'), /sourceMappingURL/);
  const { default: config } = await import('../vite.config.js');
  assert.equal(config({ command: 'build', mode: 'store' }).build.sourcemap, 'hidden');
  assert.equal(config({ command: 'build', mode: 'unpacked' }).build.sourcemap, true, 'the unpacked copy keeps its maps');
  // The script moves the store copy's maps into their own zip before zipping it.
  const script = read('scripts/package.mjs');
  assert.match(script, /moveMaps\(stage, stageMaps\);\nfs\.writeFileSync\(out, zipDirectory\(stage\)\);/);
  assert.match(script, /channel === 'store' \? withoutMapUrl\(kit\.code\) : kit\.code/);

  // Which package a bundled module comes from: node_modules, scoped or not, and the vendored files.
  assert.equal(packageOf('C:\\repo\\node_modules\\react-dom\\cjs\\react-dom.production.js'), 'react-dom');
  assert.equal(packageOf('/repo/node_modules/.pnpm/x/node_modules/@scope/pkg/index.js?commonjs-exports'), '@scope/pkg');
  assert.equal(packageOf('\0/repo/node_modules/zustand/esm/index.mjs'), 'zustand');
  assert.equal(packageOf('/repo/lib/fflate.mjs'), 'fflate');
  assert.equal(packageOf('lib/pdf.worker.min.mjs'), 'pdfjs-dist');
  assert.equal(packageOf('/repo/src/usage.js'), null);
  const found = new Set();
  noticesPlugin(found).generateBundle({}, {
    'bundle/sidepanel.js': { type: 'chunk', modules: { '/r/sidepanel/sidepanel.js': {}, '/r/node_modules/react/index.js': {}, '/r/lib/pdf.min.mjs': {} } },
    'bundle/pdf.worker.min.mjs': { type: 'asset', originalFileNames: ['lib/pdf.worker.min.mjs'] },
  });
  assert.deepEqual([...found].sort(), ['pdfjs-dist', 'react']);
  // Each with its version, licence and licence file, once; a build that reported nothing fails.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const notices = thirdPartyNotices(root, ['fflate', 'pdfjs-dist', 'fflate']);
  assert.match(notices, /^fflate \d+\.\d+\.\d+ \(MIT\)$/m);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /^pdfjs-dist \d+\.\d+\.\d+ \(Apache-2\.0\)$/m);
  assert.match(notices, /Apache License/);
  assert.equal(notices.match(/^fflate /gm).length, 1, 'once each');
  assert.throws(() => thirdPartyNotices(root, []), /no third-party code/);
  assert.match(script, /fs\.writeFileSync\(path\.join\(to, NOTICES_FILE\), thirdPartyNotices\(root, \[\.\.\.found\]\)\)/);
});

// Audit 2026-11-07, QA-11 step 2, SRV-16, CARR-18: the store zip reaches no host on this computer,
// and its carriers take no local page for a carrier; the unpacked copy keeps both for mocks.
test('the store build has no localhost: not in its manifest, not among its carriers', async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const store = storeManifest(manifest);
  assert.ok(manifest.host_permissions.some((h) => h.includes('localhost')), 'the repository manifest keeps it for the unpacked copy');
  assert.deepEqual(store.host_permissions.filter((h) => /localhost|127\.0\.0\.1/.test(h)), []);
  assert.deepEqual(store.host_permissions, manifest.host_permissions.filter((h) => !/localhost|127\.0\.0\.1/.test(h)), 'the carriers and the servers kept');
  const source = fs.readFileSync(new URL(`../${LOCAL_PAGES_FILE}`, import.meta.url), 'utf8');
  const stored = withoutLocalPages(source);
  assert.ok(stored.includes('const LOCAL_PAGES = false;') && !stored.includes('const LOCAL_PAGES = true;'));
  assert.throws(() => withoutLocalPages('no flag here'));
  const plugin = provenancePlugin({ channel: 'store', commit: null });
  assert.ok(plugin.transform(source, 'C:\\repo\\src\\carriers.js').code.includes('const LOCAL_PAGES = false;'), 'the store build stamps it');
  assert.equal(provenancePlugin({ channel: 'unpacked', commit: null }).transform(source, `/repo/${LOCAL_PAGES_FILE}`), null, 'the unpacked copy keeps local pages');
  // As the store bundle reads it: no test carrier, and a practice page is no carrier.
  const mod = await import(`data:text/javascript,${encodeURIComponent(stored.replace(/^import .*$/gm, '').replace(/^\/\*\* @import.*$/gm, '').replace(/^\s*progressive,\n\s*geico,\n\s*amwins,\n/m, ''))}`);
  assert.equal(mod.CARRIERS.some((c) => c.id === 'test'), false);
  assert.equal(mod.carrierForUrl('http://localhost:8080/test/fixtures/amwins/page.html'), null);
});
