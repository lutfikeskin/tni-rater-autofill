// Agents' own defaults (src/agent-defaults/, docs/agent-defaults-spec.md): the module is switched off,
// so the panel's plans and Luna's rulebook stay the rules' own; its overlay, applied directly, changes
// only TNI standards, exactly the rules naming the replaced standard, and gives the agent whatever it
// can't fill safely.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../src/plan.js';
import { planFor } from '../sidepanel/panel/plan-for.js';
import { rulebookFor } from '../src/ai/tni-rules.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';
import { STANDARD_IDS } from '../src/standards.js';
import { REGISTRY } from '../src/agent-defaults/registry.js';
import { makeOverlay, safeOverlay, liabilityAmount, amountSaid, AGENT_DEFAULT_SOURCE } from '../src/agent-defaults/overlay.js';
import {
  RELEASED_TO_AGENTS, agentDefaultsOn, setAgentDefaultsOn, setActiveDefaults, overlayFor, rulebookRewriteFor, makeRulebookRewrite,
  effectiveDefaults, carrierOverrides, defaultsForLog, isAgentDefault, profileFromLog, replayOverlay,
} from '../src/agent-defaults/index.js';
import { DEFAULTS_SHAPE, AGENT_DEFAULT_SOURCE as SERVER_SOURCE } from '../server/agent-defaults.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARRIERS = [progressive, amwins, geico];
const carrier = (id) => CARRIERS.find((c) => c.id === id);
const record = (state = 'OH', liability = '$1M CSL') => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', owner1: 'Amina Kone', ownerDrives: true },
  garaging: { street: '1 Test Way', city: 'Testville', state, zip: '07000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', vehicleOwnership: 'Owned' },
  drivers: [{ first: 'Amina', last: 'Kone', dob: '01/02/1980', licenseNumber: 'NJ1234567', licenseState: state, cdl: true }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [],
  trailerInfo: {},
  priorInsurance: [],
  coverage: { autoLiabLimit: liability, cargo: false },
  claims: { hasClaims: false },
});
const data = (plan) => JSON.parse(JSON.stringify(plan));
const key = (s) => s.q ?? s.name;
const EVERYTHING = { umCsl: { value: 300_000 }, medPay: { value: 2_000 }, compDeductible: { value: 500 }, collDeductible: { value: 500 }, rental: { value: { perDay: 50, max: 1_500 } } };
const withOverlay = (id, effective, rec = record()) => buildPlan(rec, carrier(id), {}, { overlay: makeOverlay(effective, id) });
// The steps an overlay changed, by question: [before, after].
const changed = (id, effective, rec = record()) => {
  const before = buildPlan(rec, carrier(id), {});
  const after = withOverlay(id, effective, rec);
  assert.equal(after.length, before.length, 'an overlay never adds or drops a step');
  return new Map(before.map((s, i) => [s, after[i]]).filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b)).map(([a, b]) => [key(a), [a, b]]));
};

// Agents' store build keeps the feature off until TNI's managers approve it; the module starts off.
test('off until the panel turns it on, as agents\' store build keeps it until released: a confirmed profile changes nothing', () => {
  assert.equal(RELEASED_TO_AGENTS, false, 'not released to agents until TNI\'s managers approve it');
  assert.equal(agentDefaultsOn(), RELEASED_TO_AGENTS, 'the module starts as the store build has it');
  setActiveDefaults({ values: EVERYTHING });
  try {
    for (const c of CARRIERS) {
      assert.equal(overlayFor(c.id), null, c.id);
      assert.equal(rulebookRewriteFor(c.id), null, c.id);
      assert.deepEqual(data(planFor(record(), c, {})), data(buildPlan(record(), c, {})), c.id);
    }
  } finally {
    setActiveDefaults(null);
  }
});

test('no profile confirmed for the quote: every plan and rulebook is the rules\' own; confirmed: the panel\'s plans take it', () => {
  setAgentDefaultsOn(true);
  for (const c of CARRIERS) {
    assert.equal(overlayFor(c.id), null);
    assert.equal(rulebookRewriteFor(c.id), null);
    for (const state of ['OH', 'TX']) assert.deepEqual(data(planFor(record(state), c, {})), data(buildPlan(record(state), c, {})), `${c.id} ${state}`);
  }
  // A profile replacing nothing changes nothing either.
  setActiveDefaults({ values: { medPay: { value: 5_000 } } });
  try {
    for (const c of CARRIERS) assert.equal(overlayFor(c.id), null);
    setActiveDefaults({ values: EVERYTHING });
    for (const c of CARRIERS) {
      assert.deepEqual(data(planFor(record(), c, {})), data(withOverlay(c.id, EVERYTHING)), c.id);
      assert.ok(rulebookRewriteFor(c.id), c.id);
    }
  } finally {
    setActiveDefaults(null);
  }
});

test('nothing replaced: the overlay is a no-op on every carrier', () => {
  for (const c of CARRIERS) {
    for (const state of ['OH', 'TX', 'FL']) assert.equal(changed(c.id, {}, record(state)).size, 0, `${c.id} ${state}`);
  }
});

test('the overlay changes TNI standards only, and exactly the rules naming the replaced standard', () => {
  const expected = {
    progressive: ['1DEE', '1E68', '1E6C', '1DCA', '1DDE', '1DBF', '1DD8', '1FCD', '1FD2', '1FF2', '1FE4'],
    geico: ['UninsuredMotorist', 'UninsuredMotoristUmbi', 'UnderinsuredMotorist', 'MedicalPayments', 'BasicPip', 'COMP', 'COLL', 'Rental'],
    amwins: ['Rental reimbursement', 'UM limit', 'Medical payments', 'Comprehensive deductible', 'Collision deductible', 'Personal Injury Protection'],
  };
  for (const c of CARRIERS) {
    const diff = changed(c.id, EVERYTHING);
    const got = [...diff.keys()].map((k) => k.replace(/ \(standard:.*$/, ''));
    assert.deepEqual(got.sort(), [...expected[c.id]].sort(), c.id);
    for (const [k, [before]] of diff) assert.equal(before.source, 'standard', `${c.id} ${k}: only a TNI standard changes`);
  }
  // The rest of GEICO's UM block keeps TNI's answers: its deductible and UM/UIM type carry no amount.
  const geico = changed('geico', EVERYTHING);
  assert.ok(!geico.has('UninsuredMotoristDeductible') && !geico.has('UmUimType'));
});

test('a replaced standard is filled with the agent\'s amount in the carrier\'s wording, tagged agent-default', () => {
  const p = changed('progressive', EVERYTHING);
  assert.equal(p.get('1DEE')[1].value, '$300k CSL');
  assert.equal(p.get('1E68')[1].value, '$300k CSL w/ $200 Deductible');
  assert.equal(p.get('1FE4')[1].value, '$2,000 per person');
  assert.equal(p.get('1FF2')[1].value, '$50 per day, $1,500 max');
  const g = changed('geico', EVERYTHING);
  assert.equal(g.get('UninsuredMotorist')[1].value, '$300,000 Combined Single Limit');
  assert.equal(g.get('COMP')[1].value, '$500 deductible');
  for (const [, after] of [...p.values(), ...g.values()].filter(([, a]) => a.source === AGENT_DEFAULT_SOURCE)) {
    assert.equal(after.resolution.method, 'agent-default');
    assert.equal(after.standard, false);
    assert.equal(after.note ?? null, null, 'a filled default carries no note (a note leaves the step to the agent)');
    assert.ok(after.agentDefault?.id && after.agentDefault.amount && after.agentDefault.tni);
    assert.ok(after.unofferedNote, 'an amount the list lacks is the agent\'s, never a quiet return to TNI\'s');
    assert.ok(Array.isArray(after.choiceAliases));
  }
  assert.equal(SERVER_SOURCE, AGENT_DEFAULT_SOURCE, 'the server logs the same source name');
});

test('a dependent of a replaced standard becomes the agent\'s: GEICO and AmWINS PIP beside Medical Payments, GEICO rental behind the deductibles', () => {
  for (const id of ['geico', 'amwins']) {
    const pip = [...changed(id, { medPay: { value: 2_000 } }).values()].map(([, b]) => b).find((s) => /pip|personal injury/i.test(key(s)));
    assert.ok(pip, `${id}: PIP changed`);
    assert.equal(pip.manualOnly, true);
    assert.equal(pip.value, null);
    assert.match(pip.note, /after medical payments/);
    assert.equal(pip.resolution.status, 'agent');
  }
  const rental = changed('geico', { compDeductible: { value: 500 } }).get('Rental')[1];
  assert.equal(rental.manualOnly, true);
  assert.match(rental.note, /after comprehensive deductible/);
  // Rental replaced too: the agent's own rental amount, not held.
  const both = changed('geico', { compDeductible: { value: 500 }, rental: { value: { perDay: 50, max: 1_500 } } }).get('Rental')[1];
  assert.equal(both.source, AGENT_DEFAULT_SOURCE);
  // Progressive has no dependents: its PIP keeps TNI's answer.
  assert.deepEqual([...changed('progressive', { medPay: { value: 2_000 } }).keys()], ['1FE4']);
});

test('Texas keeps GEICO\'s own UM split, with defaultInfo and no note; Ohio takes the default', () => {
  const tx = buildPlan(record('TX'), carrier('geico'), {});
  const txUm = withOverlay('geico', { umCsl: { value: 300_000 } }, record('TX')).find((s) => s.q === 'UninsuredMotorist');
  const plain = tx.find((s) => s.q === 'UninsuredMotorist');
  assert.equal(txUm.value, plain.value);
  assert.equal(txUm.source, 'standard');
  assert.equal(txUm.note, plain.note);
  assert.match(txUm.defaultInfo, /^TX: TNI's .* applies here/);
  const oh = withOverlay('geico', { umCsl: { value: 300_000 } }).find((s) => s.q === 'UninsuredMotorist');
  assert.equal(oh.source, AGENT_DEFAULT_SOURCE);
  assert.equal(oh.defaultInfo, undefined);
});

test('a UM default above TNI\'s amount needs a liability limit at least as high on the intake', () => {
  const um = (liability, amount = 1_000_000) => withOverlay('progressive', { umCsl: { value: amount } }, record('OH', liability)).find((s) => s.q === '1DEE');
  assert.equal(um('$1M CSL').source, AGENT_DEFAULT_SOURCE);
  assert.equal(um('$1M CSL').value, '$1 million CSL');
  for (const liability of ['$500K', '25/50/25', 'State Minimum', '', null]) {
    const step = um(liability);
    assert.equal(step.manualOnly, true, String(liability));
    assert.match(step.note, /liability limit/);
  }
  // At or below TNI's amount, no limit is needed.
  assert.equal(um('25/50/25', 100_000).source, 'standard');
  assert.equal(liabilityAmount('$750K'), 750_000);
  assert.equal(liabilityAmount('$1,000,000'), 1_000_000);
  assert.equal(liabilityAmount('1.5 million'), 1_500_000);
  assert.equal(liabilityAmount('100/300/100'), null);
});

test('"Ask me" leaves every target to the agent, never filled and never Luna\'s', () => {
  for (const c of CARRIERS) {
    const diff = changed(c.id, { medPay: { ask: true } });
    assert.ok(diff.size >= 1, c.id);
    for (const [k, [, after]] of diff) {
      assert.equal(after.manualOnly, true, `${c.id} ${k}`);
      assert.equal(after.value, null);
      assert.equal(after.resolution.status, 'agent');
      if (after.agentDefault) assert.equal(after.agentDefault.ask, true);
    }
  }
});

test('an overlay that throws gives that standard to the agent and leaves every other step alone', () => {
  const errors = [];
  const boom = safeOverlay((step, rule) => { if (rule.std?.id === 'medPay') throw new Error('boom'); return step; }, (e) => errors.push(e));
  const plain = buildPlan(record(), carrier('progressive'), {});
  const plan = buildPlan(record(), carrier('progressive'), {}, { overlay: boom });
  assert.equal(errors.length, 1);
  plan.forEach((s, i) => {
    if (s.q === '1FE4') {
      assert.equal(s.manualOnly, true);
      assert.match(s.note, /couldn't be applied/);
    } else assert.deepEqual(data(s), data(plain[i]));
  });
  // A non-standard step it throws on comes back as it was.
  const all = safeOverlay(() => { throw new Error('boom'); });
  const fromAll = buildPlan(record(), carrier('geico'), {}, { overlay: all });
  buildPlan(record(), carrier('geico'), {}).forEach((s, i) => { if (s.source !== 'standard') assert.deepEqual(data(fromAll[i]), data(s)); });
});

test('every amount a carrier\'s list offers is written in that carrier\'s wording', () => {
  for (const c of CARRIERS) {
    for (const rule of c.rules.filter((r) => r.std)) {
      const entry = REGISTRY.find((e) => e.id === rule.std.id);
      assert.ok(entry, `${c.id}: ${rule.std.id} is a registry standard`);
      for (const choice of [...entry.choices.all, ...entry.choices[c.id]]) {
        const written = rule.std.write(choice);
        assert.equal(typeof written, 'string', `${c.id} ${rule.std.id} ${amountSaid(choice)}`);
        assert.doesNotMatch(written, /\d{4,}k\b|\d{4,}K\b|NaN|undefined|object/, `${c.id} ${rule.std.id}: ${written}`);
      }
    }
  }
  const write = (id, std, amount) => carrier(id).rules.find((r) => r.std?.id === std && r.std.applies == null).std.write(amount);
  assert.equal(write('progressive', 'umCsl', 1_000_000), '$1 million CSL');
  assert.equal(write('progressive', 'umCsl', 750_000), '$750k CSL');
  assert.equal(write('amwins', 'umCsl', 1_500_000), '$1.5M');
  assert.equal(write('amwins', 'umCsl', 750_000), '$750K');
  assert.equal(write('geico', 'umCsl', 1_000_000), '$1,000,000 Combined Single Limit');
});

test('every registry standard is a TNI standard with its rules on every carrier, and TNI\'s amount among its choices', () => {
  for (const entry of REGISTRY) {
    assert.ok(STANDARD_IDS[entry.id], entry.id);
    const tni = STANDARD_IDS[entry.id]();
    assert.ok(entry.choices.all.some((c) => JSON.stringify(c) === JSON.stringify(tni)), `${entry.id}: TNI's amount offered`);
    for (const c of CARRIERS) {
      assert.ok(c.rules.some((r) => r.std?.id === entry.id), `${c.id} carries ${entry.id}`);
      for (const choice of entry.choices.all) assert.ok(entry.choices[c.id].some((x) => JSON.stringify(x) === JSON.stringify(choice)), `${c.id} sells ${entry.id} ${amountSaid(choice)}`);
    }
  }
});

test('effectiveDefaults keeps only valid replacements, the carrier\'s own winning over the basic one', () => {
  assert.deepEqual(effectiveDefaults(null, 'geico'), {});
  assert.deepEqual(effectiveDefaults({ values: {
    medPay: { value: 2_000 },
    umCsl: { value: 100_000 }, // TNI's own: no change
    compDeductible: { value: 750 }, // not offered on every carrier
    rental: { value: { perDay: 40, max: 999 } },
    nope: { value: 1 },
    collDeductible: { ask: true },
  } }, 'geico'), { medPay: { value: 2_000 }, collDeductible: { ask: true } });
  // Advanced: a carrier's own list, its own value first.
  const profile = { values: { umCsl: { value: 300_000 } }, carriers: { progressive: { umCsl: { value: 50_000 } }, geico: { umCsl: { value: 50_000 } } } };
  assert.deepEqual(effectiveDefaults(profile, 'progressive'), { umCsl: { value: 50_000 } });
  assert.deepEqual(effectiveDefaults(profile, 'geico'), {}, 'GEICO lists no $50K: the carrier\'s own invalid value is dropped, not replaced by the basic one');
  assert.deepEqual(effectiveDefaults(profile, 'amwins'), { umCsl: { value: 300_000 } });
  // A standard TNI locks keeps TNI's answer.
  const entry = REGISTRY.find((e) => e.id === 'medPay');
  entry.locked = true;
  try {
    assert.deepEqual(effectiveDefaults({ values: { medPay: { value: 2_000 } } }, 'geico'), {});
  } finally {
    delete entry.locked;
  }
});

test('defaultsForLog fits the server\'s shape, basic first, then each carrier\'s own', () => {
  const log = defaultsForLog({ values: { medPay: { value: 2_000 }, rental: { value: { perDay: 50, max: 1_500 } }, umCsl: { value: 7 } }, carriers: { geico: { umCsl: { ask: true } } } });
  assert.deepEqual(log, [{ id: 'medPay', value: 2_000 }, { id: 'rental', value: 50 }, { id: 'umCsl', value: 'ask', carrier: 'geico' }]);
  assert.ok(DEFAULTS_SHAPE(log));
  assert.deepEqual(defaultsForLog(null), []);
});

test('the rulebook rewrite tells Luna the agent\'s default on the entries stating it', () => {
  for (const c of CARRIERS) {
    assert.equal(makeRulebookRewrite({}, c.id), null);
    const rewrite = makeRulebookRewrite({ medPay: { value: 2_000 } }, c.id);
    const plain = rulebookFor(c.id);
    const rewritten = rulebookFor(c.id, { rewrite });
    const touched = rewritten.filter((e, i) => e.text !== plain[i].text);
    assert.ok(touched.length >= 1, `${c.id}: an entry states Medical Payments`);
    for (const e of touched) assert.match(e.text, /The agent's own default replaces TNI's medical payments here: \$2,000\.$/);
    const ask = rulebookFor(c.id, { rewrite: makeRulebookRewrite({ medPay: { ask: true } }, c.id) });
    assert.ok(ask.some((e) => /answers medical payments themselves/.test(e.text)));
  }
});

test('isAgentDefault reads a report item\'s method', () => {
  const step = withOverlay('progressive', { medPay: { value: 2_000 } }).find((s) => s.q === '1FE4');
  assert.equal(isAgentDefault(step), true);
  assert.equal(isAgentDefault(buildPlan(record(), carrier('progressive'), {}).find((s) => s.q === '1FE4')), false);
});

test('only the module, the panel\'s planFor and its own folder, Luna\'s evidence and the review tooling\'s adapter import it', () => {
  const allowed = new Set(['sidepanel/panel/plan-for.js', 'src/ai/common.js', 'scripts/lib/agent-defaults.mjs', 'sidepanel/panel/agent-defaults/store.js', 'sidepanel/panel/agent-defaults/view.jsx']);
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = `${dir}/${d.name}`;
    if (d.isDirectory()) return ['node_modules', 'dist', 'layouts'].includes(d.name) ? [] : walk(rel);
    return /\.(m?js|jsx)$/.test(d.name) ? [rel] : [];
  });
  const importers = ['src', 'sidepanel', 'scripts', 'server'].flatMap(walk)
    .filter((f) => !f.startsWith('src/agent-defaults/'))
    .filter((f) => /from ['"][^'"]*agent-defaults\/(index|overlay|registry)\.js['"]/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(importers.sort(), [...allowed].sort());
});

// Advanced: what a carrier's own picks change there beyond the basic ones, so the log (and the replay
// from it) says what filled each carrier, a carrier's TNI's over a basic default included.
test('a carrier\'s own picks: logged where they differ from the basic ones, TNI\'s over a basic default too', () => {
  const profile = { values: { medPay: { value: 2_000 } }, carriers: {
    geico: { medPay: { value: 5_000 }, umCsl: { value: 300_000 } }, // TNI's over the basic $2,000; its own UM
    amwins: { medPay: { value: 2_000 } }, // the same as the basic one: nothing of its own
    progressive: { medPay: { value: 7 } }, // an amount its list doesn't offer: TNI's there, as filled
  } };
  assert.deepEqual(carrierOverrides(profile, 'geico'), { umCsl: { value: 300_000 }, medPay: { value: 5_000 } });
  assert.deepEqual(carrierOverrides(profile, 'amwins'), {});
  assert.deepEqual(carrierOverrides(profile, 'progressive'), { medPay: { value: 5_000 } });
  assert.deepEqual(carrierOverrides({ values: {}, carriers: { geico: { medPay: { value: 7 } } } }, 'geico'), {}, 'no basic default: TNI\'s anyway');
  assert.deepEqual(carrierOverrides(null, 'geico'), {});
  assert.deepEqual(defaultsForLog(profile), [
    { id: 'medPay', value: 2_000 },
    { id: 'umCsl', value: 300_000, carrier: 'geico' }, { id: 'medPay', value: 5_000, carrier: 'geico' },
    { id: 'medPay', value: 5_000, carrier: 'progressive' },
  ]);
  // Replayed from the log, each carrier gets what it was filled with.
  const replayed = profileFromLog(defaultsForLog(profile));
  for (const c of ['progressive', 'amwins', 'geico']) assert.deepEqual(effectiveDefaults(replayed, c), effectiveDefaults(profile, c), c);
  assert.deepEqual(effectiveDefaults(profile, 'geico'), { umCsl: { value: 300_000 } });
  assert.deepEqual(effectiveDefaults(profile, 'progressive'), {});
});

test('a quote\'s logged defaults replay as the profile it was filled with', () => {
  const profile = { values: { medPay: { value: 2_000 }, rental: { value: { perDay: 50, max: 1_500 } } }, carriers: { geico: { umCsl: { ask: true } }, progressive: { umCsl: { value: 50_000 } } } };
  const log = defaultsForLog(profile);
  assert.deepEqual(profileFromLog(log), profile);
  for (const c of CARRIERS) assert.deepEqual(effectiveDefaults(profileFromLog(log), c.id), effectiveDefaults(profile, c.id), c.id);
  // An entry the registry or the list no longer has is left out: that standard replays as TNI's.
  assert.deepEqual(profileFromLog([{ id: 'gone', value: 1 }, { id: 'medPay', value: 7 }, { id: 'medPay', value: 1_000, carrier: 'nowhere' }]), { values: {}, carriers: {} });
  assert.equal(profileFromLog([]), null);
  assert.equal(profileFromLog(undefined), null);
  assert.equal(replayOverlay([], 'geico'), null);
  assert.equal(replayOverlay([{ id: 'medPay', value: 5_000 }], 'geico'), null, 'TNI\'s own amount: nothing replaced');
  // Not behind the off switch: it replays what a build with the feature on did.
  const replayed = buildPlan(record(), carrier('geico'), {}, { overlay: replayOverlay(log, 'geico') });
  assert.deepEqual(data(replayed), data(withOverlay('geico', effectiveDefaults(profile, 'geico'))));
});
