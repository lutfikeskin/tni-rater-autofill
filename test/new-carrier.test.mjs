import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CARRIERS, RATERS, ratersSaid } from '../src/carriers.js';

// Audit 2026-11-07, ORG-16: adding a carrier touches about a dozen places, listed only in
// docs/new-carrier.md's prose. The new-carrier issue template lists each as a box; this keeps the
// two in step and every path in it real.
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Only the boxes count: a path or setting named in the template's prose has no box to tick (the
// review of #432).
const template = read('.github/ISSUE_TEMPLATE/new-carrier.md').split('\n').filter((l) => l.startsWith('- [ ] ')).join('\n');
const named = [...template.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((p) => /^(src|test|scripts|\.github|docs)\/|\.(js|json|md)$/.test(p));

test('every path the new-carrier template names exists, for each carrier where it names one', () => {
  assert.ok(named.length >= 10, `found ${named.length} paths`);
  for (const p of named) {
    if (!p.includes('<carrier>')) { assert.ok(fs.existsSync(new URL(`../${p}`, import.meta.url)), `${p} exists`); continue; }
    // A page adapter only where the carrier's widgets need one: each carrier that names one
    // (`pageAdapter`) has it at this path. Every carrier with rules of its own (the local test page
    // has none) has the rest.
    if (p === 'src/content/carriers/<carrier>.js') {
      const adapters = CARRIERS.filter((c) => c.pageAdapter);
      assert.ok(adapters.length >= 1);
      for (const c of adapters) {
        assert.equal(c.pageAdapter, p.replace('<carrier>', c.id), `${c.id}'s pageAdapter`);
        assert.ok(fs.existsSync(new URL(`../${c.pageAdapter}`, import.meta.url)), `${c.pageAdapter} exists`);
      }
      continue;
    }
    for (const carrier of CARRIERS.filter((c) => c.rules?.length).map((c) => c.id)) {
      const real = p.replace('<carrier>', carrier);
      assert.ok(fs.existsSync(new URL(`../${real}`, import.meta.url)), `${real} exists, as the template's ${p} says each carrier has`);
    }
  }
});

test('the template names every file docs/new-carrier.md\'s adapter steps link to', () => {
  const steps = /## Implement the adapter\n([\s\S]*?)\n## /.exec(read('docs/new-carrier.md'))?.[1] ?? '';
  // The general part of the rulebook is linked as what already holds TNI's decisions, not a touchpoint.
  const linked = [...steps.matchAll(/\]\(\.\.\/([^)#]+)/g)].map((m) => m[1]).filter((p) => !p.startsWith('docs/') && p !== 'src/ai/rulebook/general.js');
  assert.ok(linked.length >= 8, `found ${linked.length} links`);
  for (const p of new Set(linked)) assert.ok(named.some((n) => n === p || n.startsWith(p)), `the template names ${p}`);
});

// The review of #432: the settings that keep agents' corrections and the agent's own pages safe
// have their boxes too, each one the adapter steps name.
test('the template has a box for the correction keys, the agent\'s stops and where Continue may be clicked', () => {
  const steps = /## Implement the adapter\n([\s\S]*?)\n## /.exec(read('docs/new-carrier.md'))?.[1] ?? '';
  for (const option of ['shared.keys', 'stopPages', 'stopSteps', 'stopButtons', 'stopped', 'advance', 'useGenericRules']) {
    assert.ok(steps.includes(`\`${option}`), `docs/new-carrier.md's adapter steps name ${option}`);
    assert.ok(template.includes(`\`${option}\``), `the template names ${option}`);
  }
  assert.match(template, /`advance` only on pages or steps it lists: never on one that binds, buys, submits, orders reports or signs, and never on a stop page or step/);
  // docs/new-carrier.md step 2: what the intake doesn't answer, without a TNI standard, is the agent's.
  assert.match(steps, /every question the intake doesn't answer is the agent's/);
  assert.match(template, /^- \[ \] Step 2: a question the intake doesn't answer and TNI has no standard for stays the agent's, shown as unanswered: never filled as No or not applicable$/m);
});

// Audit 2026-11-07, CARR-10: the registries outside a carrier's own file that name each carrier.
// Each carrier with rules is in every one, or this list says why it isn't; one that fails quietly
// (no logo, the dashboard showing its raw id, a defaults choice list missing) fails here instead.
const LEFT_OUT = {
  // src/util.js CARRIER_NAMES: the words of a carrier's name, for "currently insured with this carrier".
  names: { amwins: 'AmWINS asks no same-carrier question (src/carriers/amwins.js uses no sameCarrier)' },
  // scripts/intake-mocks.mjs: the synthetic-intake runs drive the AmWINS mock and the Progressive replays.
  intakeMocks: { geico: 'GEICO\'s mock is its one fixture run, npm run mock:geico' },
  // package.json: a mock:<carrier> command.
  mock: { progressive: 'Progressive\'s fixture replays are npm run e2e' },
};
test('every registry names each carrier with rules, or says here why not', async () => {
  const { RULE_FILES } = await import('../src/usage.js');
  const { CARRIER_PARTS } = await import('../src/ai/tni-rules.js');
  const { REGISTRY } = await import('../src/agent-defaults/registry.js');
  const dashboard = /const CARRIERS = (\{[^}]*\})/.exec(read('server/dashboard.mjs'))?.[1] ?? '';
  const nameKeys = [.../const CARRIER_NAMES = \{([\s\S]*?)\n\};/.exec(read('src/util.js'))?.[1].matchAll(/^ {2}(\w+): \{/gm) ?? []].map((m) => m[1]);
  // The runner's carriers: its RUNNERS, which its default, the carriers it accepts and its dispatch
  // all read, and nothing else picks a carrier's case.
  const mocksText = read('scripts/intake-mocks.mjs');
  const runners = /const RUNNERS = \{(.*)\};$/m.exec(mocksText)?.[1] ?? '';
  const intakeMocks = [...runners.matchAll(/(?:^|,)\s*(\w+): \(/g)].map((m) => m[1]);
  assert.ok(intakeMocks.length, 'scripts/intake-mocks.mjs: its RUNNERS are found');
  assert.match(mocksText, /arg\('carrier', 'both'\) === 'both' \? Object\.keys\(RUNNERS\)/, 'its default is every runner');
  assert.match(mocksText, /carriers\.some\(c => !Object\.hasOwn\(RUNNERS, c\)\)/, 'it accepts only a carrier with a runner');
  assert.match(mocksText, /: RUNNERS\[carrier\]\(/, 'it runs the carrier\'s own case');
  assert.doesNotMatch(mocksText, /carrier === '/, 'no case chosen by a carrier\'s id outside RUNNERS');
  const scripts = JSON.parse(read('package.json')).scripts;
  const has = (where, id, yes) => assert.ok(yes || LEFT_OUT[where]?.[id], `${id}: missing from ${where}, and LEFT_OUT doesn't say why`);
  const carriers = CARRIERS.filter((c) => c.rules?.length);
  assert.ok(carriers.length >= 3);
  for (const c of carriers) {
    assert.ok(RULE_FILES.includes(`src/carriers/${c.id}.js`), `${c.id}: in RULE_FILES (src/usage.js)`);
    assert.ok(CARRIER_PARTS[c.id], `${c.id}: a rulebook part`);
    assert.ok(dashboard.includes(`${c.id}: '${c.name}'`), `${c.id}: the dashboard's name for it is "${c.name}" (server/dashboard.mjs)`);
    for (const entry of REGISTRY) assert.ok(entry.choices?.[c.id], `${c.id}: agents' defaults ${entry.id} lists its choices`);
    assert.ok(ratersSaid().includes(c.name), `${c.id}: named on the panel's "Open the client's quote" line`);
    has('names', c.id, nameKeys.includes(c.id));
    has('intakeMocks', c.id, intakeMocks.includes(c.id));
    has('mock', c.id, !!scripts[`mock:${c.id}`]);
  }
  // A reason only for what is really left out: each one names a carrier still missing there.
  const present = { names: (id) => nameKeys.includes(id), intakeMocks: (id) => intakeMocks.includes(id), mock: (id) => !!scripts[`mock:${id}`] };
  assert.deepEqual(Object.keys(LEFT_OUT).sort(), Object.keys(present).sort(), 'LEFT_OUT names the registries checked here');
  for (const [where, ids] of Object.entries(LEFT_OUT)) {
    for (const id of Object.keys(ids)) {
      assert.ok(carriers.some((c) => c.id === id), `${where}: ${id} is a carrier`);
      assert.ok(!present[where](id), `${where}: ${id} is there now, so LEFT_OUT's reason is stale`);
    }
  }
});

// Audit 2026-11-07, UX-14: the panel's logos, the dock's list of raters, the caption and review
// mode's wording were written into the panel's code, in four places a new carrier would miss. Each
// carrier with rules says them in its own `display`; a logo opens its agent site, on its own hosts.
test('every carrier with rules says how the panel shows it: a logo on disk, its agent site on its hosts, its product and classes', () => {
  const real = CARRIERS.filter((c) => c.rules?.length);
  assert.deepEqual(RATERS.map((c) => c.id), real.map((c) => c.id));
  for (const { id, hosts, display } of real) {
    assert.ok(display, `${id} has a display`);
    assert.ok(fs.existsSync(new URL(`../sidepanel/${display.logo}`, import.meta.url)), `${id}'s logo ${display.logo} exists`);
    const url = new URL(display.portalUrl);
    assert.equal(url.protocol, 'https:', `${id}'s agent site is https`);
    assert.ok(hosts.some((h) => h.test(url.hostname)), `${id}'s agent site ${url.hostname} is one of its hosts`);
    assert.ok(display.product && display.classesSaid, `${id} names its product and classes`);
  }
  assert.equal(ratersSaid(), 'Progressive, GEICO or AmWINS.');
  assert.equal(ratersSaid(RATERS.slice(0, 1)), 'Progressive.');
});

test('docs/new-carrier.md and the template name the carrier\'s display', () => {
  assert.match(read('docs/new-carrier.md'), /`display`/);
  assert.match(template, /`display`/);
});
