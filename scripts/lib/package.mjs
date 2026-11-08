// Pieces of scripts/package.mjs that are checked by tests.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The scripts injected into the carrier page's own JavaScript world stay there across an extension
// reload or update; each names its build, and one from another build is replaced, not reused.
// The build is the scripts' content hash, stamped into the packaged copies ('source' when the
// repository's files run as they are: tests, the replay pages). STAMPED are copied as they are;
// the fill engine is built (scripts/lib/kit.mjs) and stamped as built, where the build printed the
// placeholder in double quotes.
export const STAMPED = ['src/content/field-key.js'];
const PLACEHOLDER = /const BUILD = (['"])source\1;/g;

export const buildId = (texts) => crypto.createHash('sha256').update(texts.join('\0')).digest('hex').slice(0, 12);

export function stampBuild(text, build) {
  if ((text.match(PLACEHOLDER) ?? []).length !== 1) throw new Error("expected one const BUILD = 'source';");
  return text.replace(PLACEHOLDER, `const BUILD = '${build}';`);
}

// Which copy logged an event and from which code (sidepanel/usage-log.js): the store zip or the
// unpacked copy, and the commit it was packaged from (+dirty when packaged files had changes).
// The repository's files running as they are say 'source' and no commit.
export const PROVENANCE_FILE = 'sidepanel/usage-log.js';
const PROVENANCE = "const PROVENANCE = { channel: 'source', commit: null };";
export function stampProvenance(text, { channel, commit }) {
  if (text.split(PROVENANCE).length !== 2) throw new Error(`expected one ${PROVENANCE}`);
  if (!['store', 'unpacked'].includes(channel)) throw new Error(`unknown channel ${channel}`);
  if (commit != null && !/^[0-9a-f]{7,12}(\+dirty)?$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  return text.replace(PROVENANCE, `const PROVENANCE = { channel: '${channel}', commit: ${commit ? `'${commit}'` : 'null'} };`);
}

// The store zip's name: tni-rater-autofill-<version>.zip, or for a build made to try out
// (`npm run package -- --label test-build`) its label and the commit it was packaged from as well,
// tni-rater-autofill-<version>-<label>-<commit>.zip, so a test build is named by the script, never
// by hand (audit 2026-11-07, QA-17). A label is lowercase words and hyphens.
export function zipName(version, { label = null, commit = null } = {}) {
  if (label == null) return `tni-rater-autofill-${version}.zip`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label) || label.length > 40) throw new Error(`a label is lowercase words and hyphens: ${label}`);
  return `tni-rater-autofill-${version}-${label}-${(commit ?? 'nocommit').replace('+', '-')}.zip`;
}

// What the extension runs: the files and folders npm run package copies (the panel's built). Not
// lib/: the vendored PDF.js and fflate are imported only by the panel, whose build carries them
// (audit 2026-11-07, QA-09); their licences go in THIRD_PARTY_NOTICES.txt instead.
export const PACKAGED = ['manifest.json', 'background.js', 'icons', 'sidepanel', 'src'];

// The store zip carries no source maps (audit 2026-11-07, QA-09): they are as big as the code
// again. The store build's maps go in a zip of their own beside it, named after it, to read an
// agent's stack trace against the code they ran; the unpacked copy keeps its maps in place.
export const mapsZipName = (zip) => zip.replace(/\.zip$/, '-sourcemaps.zip');
// The fill engine's built code names its map in its last line; the store copy, without the map,
// doesn't (the panel's build leaves it out itself: sourcemap 'hidden' in store mode).
export function withoutMapUrl(code) {
  const out = code.replace(/\n\/\/# sourceMappingURL=[^\n]*\s*$/, '\n');
  if (out === code) throw new Error('expected the code to end with its sourceMappingURL');
  return out;
}

// Third-party code the package carries, and its licences (audit 2026-11-07, QA-09): the npm
// packages the panel's build and the fill engine take in, each named by the path of a module they
// bundled, and the files scripts/vendor.mjs copies into lib/ from the packages named here.
export const VENDORED = { 'lib/pdf.min.mjs': 'pdfjs-dist', 'lib/pdf.worker.min.mjs': 'pdfjs-dist', 'lib/fflate.mjs': 'fflate' };
export function packageOf(id) {
  const file = id.replaceAll('\\', '/').replace(/^\0/, '').replace(/\?.*$/, '');
  const at = file.lastIndexOf('/node_modules/');
  if (at >= 0) {
    const [first, second] = file.slice(at + '/node_modules/'.length).split('/');
    return first.startsWith('@') ? `${first}/${second}` : first;
  }
  const lib = Object.keys(VENDORED).find((f) => file === f || file.endsWith(`/${f}`));
  return lib ? VENDORED[lib] : null;
}

// What a Vite build took in from other people's code: its chunks' modules and the files it emitted
// as they were (PDF.js's worker), as package names, added to `found`.
export function noticesPlugin(found) {
  return {
    name: 'tni-notices',
    generateBundle(_, bundle) {
      for (const out of Object.values(bundle)) {
        const ids = out.type === 'chunk' ? Object.keys(out.modules) : out.originalFileNames ?? [];
        for (const id of ids) {
          const name = packageOf(id);
          if (name) found.add(name);
        }
      }
    },
  };
}

// THIRD_PARTY_NOTICES.txt: each package's name, version and licence, then its licence file as the
// package ships it. A package without one fails the package, rather than going out unnoticed.
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';
export function thirdPartyNotices(root, names) {
  const parts = [...new Set(names)].sort().map((name) => {
    const dir = path.join(root, 'node_modules', ...name.split('/'));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const file = fs.readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
    if (!file) throw new Error(`${name} has no licence file to carry`);
    const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim();
    return `${pkg.name} ${pkg.version} (${pkg.license})\n${'-'.repeat(60)}\n${text}\n`;
  });
  if (!parts.length) throw new Error("no third-party code found: the build didn't report its modules");
  return `TNI Rater Autofill carries the following third-party software, under these licences.\n\n${parts.join('\n\n')}`;
}

// The commit the packaged files come from, +dirty when they, or what builds the panel, have changes
// git doesn't have; none when git can't say (the package is still built).
export function packagedCommit(root) {
  try {
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const sha = git('rev-parse', '--short=10', 'HEAD');
    return git('status', '--porcelain', '--', ...PACKAGED, 'vite.config.js', 'package.json', 'package-lock.json') ? `${sha}+dirty` : sha;
  } catch {
    return null;
  }
}

// The panel is bundled (vite.config.js), so its copy of usage-log.js is stamped as the build reads
// it. A build that never read the file fails, rather than logging every event as 'source'.
export function provenancePlugin(stamp) {
  let stamped = false;
  return {
    name: 'tni-provenance',
    // On the file as written, before Vite's own transforms change its text.
    enforce: 'pre',
    // A watch build (npm run panel:watch) is rebuilt from files being edited after the commit was
    // read, so it is never a clean commit (review of #239).
    buildStart() {
      if (this.meta.watchMode && stamp.commit && !stamp.commit.endsWith('+dirty')) stamp = { ...stamp, commit: `${stamp.commit}+dirty` };
    },
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith(`/${PROVENANCE_FILE}`)) return null;
      stamped = true;
      return { code: stampProvenance(code, stamp), map: null };
    },
    buildEnd(error) {
      if (!error && !stamped) throw new Error(`the panel's build didn't include ${PROVENANCE_FILE}`);
    },
  };
}

// Panel files the build bundles (sidepanel/*.js, .html, .css): left out of the copy, which gets the
// build's instead. Its sounds and images stay, since the panel names some of them at run time.
export const bundledPanelFile = (rel) => /^sidepanel\/.*\.(js|html|css)$/.test(rel.replaceAll('\\', '/'));

// The fill engine's source (src/kit/): left out of the copy, which gets the built kit instead
// (scripts/lib/kit.mjs) at src/content/pagekit.js.
export const kitSourceFile = (rel) => /^src\/kit(\/|$)/.test(rel.replaceAll('\\', '/'));

// The unpacked copy (Load unpacked) gets a fixed extension ID through this public key, so its
// settings (the agent's OpenAI key among them) survive removing and loading it again, from any
// folder. Only the public half: Chrome needs nothing else for an unpacked extension. Never in the
// store zip: the Chrome Web Store refuses a manifest with a key and gives its own ID.
export const DEV_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr8PERxTmrlU9kI7ekp0/yiAtNNZDXioK/SAqXCvMioK80wbfdItULEKpQ979/bcqcEuS83yugqAdMigTwhHAAyFCMDLzAY8G8jx0QiY8F/I8/SRezncn7K9QnFNzyTa2a2YtuuLUkUiAxwmo3w0CUK5gAAclVI8bCfeHnWbK0RHQXPw6R1ktfm3e+Z8U2++oy/4ytgEMhyVi0Jt0GoXkTymjoPUpGgRTEW5mRxuG7uZXVH/LbiW5RbYtpLfvzyZ0SmvY4w2lG6z91saRDN1qVeaL+Fx14nmeNo3WLsIZT5eSYrCHt+qX8wjff9zHY0r5O2GRvAp0Kw9Yyp4UDPKSyQIDAQAB';
export const DEV_EXTENSION_ID = 'cbpjccegchfackokbiogplhdekblkccj';

export const devManifest = (manifest) => ({ ...manifest, key: DEV_KEY });

// The extension ID Chrome derives from a manifest key.
export function extensionId(key) {
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
