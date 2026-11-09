// Audit 2026-11-07, UX-03: a fill kept running after the side panel was closed, with no live list,
// no Stop and no report. The panel says its running fill over a 'fill-watch' port; the service
// worker stops that run (the kit's stopRun) when the port goes while the fill runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFillWatch, watchedRun } from '../src/fill-watch.js';

const fakePort = (name = 'fill-watch') => {
  const on = { message: [], disconnect: [] };
  return {
    name,
    onMessage: { addListener: (f) => on.message.push(f) },
    onDisconnect: { addListener: (f) => on.disconnect.push(f) },
    say: (msg) => on.message.forEach((f) => f(msg)),
    go: () => on.disconnect.forEach((f) => f()),
  };
};
const fakeChrome = () => {
  const ran = [];
  const connect = [];
  return {
    ran,
    connect: (port) => connect.forEach((f) => f(port)),
    runtime: { lastError: undefined, onConnect: { addListener: (f) => connect.push(f) } },
    scripting: { executeScript: async (call) => { ran.push(call); return []; } },
  };
};

test('a panel that goes while its fill runs: the worker stops that run in every frame, in its world', async () => {
  const api = fakeChrome();
  createFillWatch(api).listen();
  const port = fakePort();
  api.connect(port);
  port.say({ tabId: 7, run: 'run-1', world: 'MAIN' });
  port.go();
  assert.equal(api.ran.length, 1);
  const [call] = api.ran;
  assert.deepEqual([call.target, call.world, call.args], [{ tabId: 7, allFrames: true }, 'MAIN', ['run-1']]);
  // What it runs in the page: the kit's stopRun with that run, nothing broader.
  let asked = null;
  globalThis.__raterKit = { stopRun: (run) => { asked = run; return true; }, stop: () => { throw new Error('stop() halts any run'); } };
  try { assert.equal(call.func('run-1'), true); } finally { delete globalThis.__raterKit; }
  assert.equal(asked, 'run-1');
});

test('a fill that ended, a port for something else, or no fill said: nothing is stopped', () => {
  const api = fakeChrome();
  createFillWatch(api).listen();
  const ended = fakePort();
  api.connect(ended);
  ended.say({ tabId: 7, run: 'run-1', world: 'ISOLATED' });
  ended.say({ tabId: null });
  ended.go();
  const other = fakePort('tab-mark');
  api.connect(other);
  other.go();
  const quiet = fakePort();
  api.connect(quiet);
  quiet.go();
  assert.deepEqual(api.ran, []);
  // What the panel says is checked: a tab, a run id; any world but MAIN is the isolated one.
  assert.equal(watchedRun({ tabId: '7', run: 'x' }), null);
  assert.equal(watchedRun({ tabId: 7, run: '' }), null);
  assert.deepEqual(watchedRun({ tabId: 7, run: 'x', world: 'page' }), { tabId: 7, run: 'x', world: 'ISOLATED' });
});

test('the panel says each fill as watchFill begins it and that it ended as it stops; the worker listens', () => {
  const coordinator = readFileSync(new URL('../sidepanel/panel/coordinator.js', import.meta.url), 'utf8');
  const watch = coordinator.slice(coordinator.indexOf('function watchFill(ctx) {'));
  assert.match(watch, /^function watchFill\(ctx\) \{\n\s+if \(!inExtension\) return \(\) => \{\};[\s\S]{0,300}fillRunning\(ctx\.run, ctx\.tabId, worldFor\(ctx\.carrier\)\);/);
  assert.match(watch, /return \(\) => \{ clearInterval\(timer\); fillEnded\(ctx\.run\); \};/);
  const panel = readFileSync(new URL('../sidepanel/panel/fill-watch.js', import.meta.url), 'utf8');
  assert.match(panel, /chrome\.runtime\.connect\(\{ name: 'fill-watch' \}\)/);
  const worker = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(worker, /createFillWatch\(chrome\)\.listen\(\);/);
});
