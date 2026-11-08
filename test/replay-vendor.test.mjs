import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root));
const VENDOR = 'test/replay/vendor/extjs-6.2.0/';

// Audit 2026-11-07, QA-13: the replay page loaded ExtJS 6.2.0 from cdnjs, so a CDN outage failed the
// Progressive job for reasons unrelated to the code. It is vendored, with its licence, and still
// pinned by sha384.
test('the replay pages load the vendored ExtJS, pinned by digest, and no test page loads it from the network', (t) => {
  for (const page of ['test/replay/index.html', 'test/mock-progressive/index.html']) {
    const html = read(page).toString('utf8');
    const dir = new URL(page.replace(/[^/]+$/, ''), root);
    const tags = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]*extjs[^"]*)"[^>]*>/g)];
    assert.equal(tags.length, 2, `${page}: the theme and ext-all.js`);
    for (const [tag, src] of tags) {
      assert.doesNotMatch(src, /^https?:/, `${page} loads ${src} from the network`);
      const integrity = tag.match(/integrity="sha384-([^"]+)"/)?.[1];
      assert.ok(integrity, `${page}: ${src} is pinned`);
      const bytes = fs.readFileSync(new URL(src, dir));
      assert.equal(crypto.createHash('sha384').update(bytes).digest('base64'), integrity, `${page}: ${src} is the file as cdnjs served it`);
    }
  }
  // The theme's two halves and what they name, as served; the licence beside them.
  for (const f of ['theme-classic-all_1.css', 'theme-classic-all_2.css', 'images/form/trigger.gif']) {
    assert.ok(fs.existsSync(new URL(`${VENDOR}classic/theme-classic/resources/${f}`, root)), f);
  }
  assert.match(read(`${VENDOR}LICENSE`).toString('utf8'), /^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(read(`${VENDOR}ext-all.js`).toString('utf8').slice(0, 800), /Ext JS 6\.2\.0[\s\S]*GNU General Public License version 3\.0/);
  // Kept byte for byte on every operating system, or the digest fails on a Windows checkout.
  assert.match(read('.gitattributes').toString('utf8'), /^test\/replay\/vendor\/\*\* -text$/m);
  let pages;
  try {
    pages = execFileSync('git', ['ls-files', '-z', 'test/*.html'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    t.skip('git is not available here');
    return;
  }
  assert.ok(pages.length > 2);
  const cdn = pages.filter((f) => /\b(?:src|href)="https?:\/\/[^"]*extjs/i.test(read(f).toString('utf8')));
  assert.deepEqual(cdn, [], 'a test page that loads ExtJS from the network');
});

test('the replay server serves the vendored theme\'s images and fonts by their types', async () => {
  const { createReplayServer } = await import('../scripts/lib/replay-server.mjs');
  const server = createReplayServer(fileURLToPath(root));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  try {
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    const res = await fetch(`http://127.0.0.1:${port}/${VENDOR}classic/theme-classic/resources/images/form/trigger.gif`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/gif');
  } finally {
    server.close();
  }
});
