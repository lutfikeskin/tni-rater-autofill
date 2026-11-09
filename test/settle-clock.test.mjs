// @ts-check
// The shared quiet clock (speed review, 2026-11-09): a wait asked with `since` counts its quiet from
// the page's last change before it, the kit's own last write or press, or the page's last request,
// not from its own start. Its window stays as long; only the time the page was already quiet counts.
import test from 'node:test';
import assert from 'node:assert/strict';

// What settle reads of a browser: a body to watch, observers the test can fire, no busy page.
/** @type {Set<{ fire: () => void, pending: boolean }>} */
const observers = new Set();
class FakeObserver {
  /** @param {() => void} cb */
  constructor(cb) { this.cb = cb; this.pending = false; this.live = false; }
  observe() { this.live = true; observers.add(this); }
  disconnect() { this.live = false; observers.delete(this); }
  takeRecords() { const had = this.pending; this.pending = false; return had ? [{}] : []; }
  fire() { if (this.live) this.cb(); }
}
const body = { querySelector: () => null, querySelectorAll: () => [] };
Object.assign(globalThis, { MutationObserver: FakeObserver, document: { body, querySelector: () => null, querySelectorAll: () => [] } });
const { settle, noteOwnAction } = await import('../src/kit/adapter.js');
const changePage = () => { for (const o of observers) o.fire(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timed = async (options) => { const t = Date.now(); await settle(options); return Date.now() - t; };

test('a wait with `since` counts the quiet the page already had; without it, its whole window from its start', async () => {
  await settle({ quietMs: 50, maxMs: 1000, abort: null });
  changePage();
  await sleep(300);
  // The page has been quiet 300 ms: a 250 ms window asked with `since` is already over.
  assert.ok(await timed({ quietMs: 250, maxMs: 2000, abort: null, since: true }) < 60);
  // Without it, the whole window from its start, as before.
  assert.ok(await timed({ quietMs: 250, maxMs: 2000, abort: null }) >= 245);
});

test('a page change after the wait before, or the kit\'s own write or press, counts as the last change', async () => {
  await settle({ quietMs: 20, maxMs: 1000, abort: null });
  await sleep(200);
  changePage();
  // Changed 0 ms ago: the window runs whole.
  assert.ok(await timed({ quietMs: 200, maxMs: 2000, abort: null, since: true }) >= 190);
  await sleep(250);
  noteOwnAction();
  assert.ok(await timed({ quietMs: 200, maxMs: 2000, abort: null, since: true }) >= 190, 'the kit\'s own write restarts it');
  // A change mid-wait restarts the window there, as always.
  changePage();
  setTimeout(changePage, 100);
  assert.ok(await timed({ quietMs: 200, maxMs: 2000, abort: null, since: true }) >= 290);
});

test('with no wait before it on this body, a wait with `since` counts from its start', async () => {
  await settle({ quietMs: 20, maxMs: 1000, abort: null });
  await sleep(300);
  const before = document.body;
  // The page replaced its body: what was watched is gone.
  document.body = /** @type {any} */ ({ ...body });
  try {
    assert.ok(await timed({ quietMs: 200, maxMs: 2000, abort: null, since: true }) >= 190);
  } finally { document.body = before; }
});
