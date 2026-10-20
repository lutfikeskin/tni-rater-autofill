import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { CARRIERS } from '../src/carriers.js';
import { benchmark } from '../scripts/lib/benchmark.mjs';
import { markdown, NO_TEST_LIST, signals } from '../scripts/lib/signals.mjs';
import {
  agentVerdict, answerKind, byIdOnly, compareKey, keyCells, keyVerdict, quotePage, readKey, scoreKey, sheetHtml, sheetModel, unitPath, wanted,
} from '../scripts/lib/answer-key.mjs';

// Synthetic only: the fake sample intake and made-up quotes of it. A real key, its sheet and the
// intake PDFs hold client answers and stay in ignored layouts/.
const raw = await readIntakeFields(pdfjs, new Uint8Array(fs.readFileSync(new URL('./fixtures/sample-intake.pdf', import.meta.url))));
const COMP = 'Does the customer need Comprehensive or Collision coverage to protect this vehicle in an accident or loss?';
const COMP_ID = 'progressive|AddVehicle|ref:RiskInput.CompCollIndicator';
const DOB_ID = 'progressive|AddDriver|text:date of birth';
const COLOR_ID = 'progressive|AddDriver|text:favorite color';

// Quotes of the sample intake (MD) and of another (`other`, also the sample PDF, under another
// fingerprint): an autofill kept, a question no rule knows, a typed date of birth; in `fixed`, the
// agent corrected the autofill.
function quotes() {
  const events = [];
  let t = Date.parse('2026-10-05T12:00:00Z');
  const e = (session, x) => events.push({ id: crypto.randomUUID(), t: new Date(t += 1000).toISOString(), session, intakeId: session === 'other' ? 'other' : 'sample', carrier: 'progressive', ...x });
  for (const s of ['kept', 'fixed', 'other']) {
    e(s, { type: 'intake_loaded', carrier: undefined, state: 'MD', businessClass: 'Expediter' });
    e(s, { type: 'fill_field', page: 'AddVehicle', view: 't1:v0', q: '2CCC', key: 'ref:RiskInput.CompCollIndicator', label: COMP, controlKind: 'radio', result: 'filled', path: 'progressive.q2CCC', shown: 'Yes' });
    e(s, { type: 'field_change', page: 'AddDriver', view: 't1:d0', q: '9Z01', key: '9Z01', label: 'Favorite color', kind: 'select', by: 'agent', from: null, to: 'Blue' });
    e(s, { type: 'field_change', page: 'AddDriver', view: 't1:d0', q: '28A0', key: '28A0', label: 'Date of Birth', kind: 'text', by: 'agent', change: 'entered', matchesIntake: ['drivers[0].dob'] });
  }
  e('fixed', { type: 'field_change', page: 'AddVehicle', view: 't1:v0', q: '2CCC', key: 'ref:RiskInput.CompCollIndicator', label: COMP, kind: 'radio', by: 'agent', autofilled: 'progressive.q2CCC', vsAutofill: 'different', from: 'Yes', to: 'No' });
  // Not quote questions: one known only by its id, one on the portal's login page.
  e('kept', { type: 'field_change', page: 'AddVehicle', view: 't1:v0', q: '9Z02', key: '9Z02', label: '', kind: 'select', by: 'agent', from: null, to: 'A' });
  e('kept', { type: 'field_change', page: '/Login/', q: '9Z03', key: '9Z03', label: 'Remember me', kind: 'checkbox', by: 'agent', from: 'unchecked', to: 'checked' });
  return events;
}
const raws = new Map([['sample', raw], ['other', raw]]);
const rowsOf = (events = quotes()) => benchmark(events, { carriers: CARRIERS, raws, detail: true }).rows;
const key = (questions, quotes = { sample: {} }) => readKey({ kind: 'tni-answer-key', version: 1, questions, quotes });
const by = { by: 'TST', date: '2026-10-20' };

test('benchmark rows carry the answer\'s source, and their detail never reaches --save', () => {
  const rows = rowsOf();
  const comp = rows.find((r) => r.session === 'kept' && r.question === COMP_ID);
  assert.equal(comp.source, 'standard');
  assert.equal(rows.find((r) => r.question === DOB_ID).source, 'intake');
  assert.ok(comp.detail.record);
  // The intake's values stay in memory: a saved run has no detail.
  assert.equal('detail' in JSON.parse(JSON.stringify(comp)), false);
});

test('readKey takes the four kinds of answer and refuses ids, bad answers and quote-level "per quote"', () => {
  assert.equal(answerKind({ value: 'Yes' }), 'value');
  assert.equal(answerKind({ value: 0 }), 'value');
  assert.equal(answerKind({ fromIntake: 'drivers[].dob' }), 'fromIntake');
  assert.equal(answerKind({ agent: true }), 'agent');
  assert.equal(answerKind({ na: true }), 'na');
  assert.equal(answerKind({ value: '' }), null);
  assert.equal(answerKind({ value: 'Yes', agent: true }), null);
  assert.equal(answerKind({ fromIntake: 'drivers[].dob; rm' }), null);
  assert.ok(key({ [COMP_ID]: { answer: { value: 'Yes' }, states: ['MD'], proposed: true, ...by } }));
  assert.throws(() => key({ [COMP_ID]: { answer: { value: 'Yes' }, proposed: 'yes' } }), /no valid answer/);
  assert.throws(() => readKey({ kind: 'benchmark-run', version: 1 }), /not an answer key/);
  assert.throws(() => key({ 'progressive|AddVehicle|q:2CCC': { answer: { value: 'Yes' } } }), /no valid answer/);
  assert.throws(() => key({ [COMP_ID]: { answer: { value: 'Yes' }, states: ['Maryland'] } }), /no valid answer/);
  assert.throws(() => key({}, { sample: { [`${COMP_ID}#v0@1`]: { answer: { perQuote: true } } } }), /no valid answer/);
  assert.equal(byIdOnly('progressive|AddVehicle|2771'), true);
  assert.equal(byIdOnly(COMP_ID), false);
  assert.equal(quotePage('progressive', '/Login/'), false);
  assert.equal(quotePage('amwins', '/application/businessauto › Drivers'), true);
  assert.equal(quotePage('amwins', '/application/commercialproperty'), false);
  // GEICO: every step is /quote; the gateway (its search and the agent's dashboard) is not the quote.
  assert.equal(quotePage('geico', '/quote'), true);
  assert.equal(quotePage('geico', '/quote › Vehicles'), true);
  assert.equal(quotePage('geico', '/'), false);
  assert.equal(quotePage('geico', '/dashboard'), false);
  assert.equal(quotePage('geico', '/quotes'), false);
});

test('scoreKey: right, wrong, missed and invented against TNI\'s answers', () => {
  const rows = rowsOf();
  const result = (k, question) => scoreKey(rows, k).scored.find((s) => s.question === question)?.result;
  // TNI's standard, as today's rule gives it; another answer is wrong.
  assert.equal(result(key({ [COMP_ID]: { answer: { value: 'Yes' }, ...by } }), COMP_ID), 'right');
  assert.equal(result(key({ [COMP_ID]: { answer: { value: 'No' }, ...by } }), COMP_ID), 'wrong');
  // A client fact the rules fill is invented; one they leave to the agent is right.
  assert.equal(result(key({ [COMP_ID]: { answer: { agent: true }, ...by } }), COMP_ID), 'invented');
  assert.equal(result(key({ [COMP_ID]: { answer: { na: true }, ...by } }), COMP_ID), 'invented');
  assert.equal(result(key({ [COLOR_ID]: { answer: { agent: true }, ...by } }), COLOR_ID), 'right');
  // An answer the key has that no rule gives is missed.
  assert.equal(result(key({ [COLOR_ID]: { answer: { value: 'Blue' }, ...by } }), COLOR_ID), 'missed');
  // The intake's answer: the rule reads the same path; a blank intake answer is missing information.
  assert.equal(result(key({ [DOB_ID]: { answer: { fromIntake: 'drivers[].dob' }, ...by } }), DOB_ID), 'right');
  assert.equal(result(key({ [DOB_ID]: { answer: { fromIntake: 'drivers[].licenseIssued' }, ...by } }), DOB_ID), 'invented');
  // A question with no answer in the key is not keyed.
  assert.equal(result(key({}), COMP_ID), 'unkeyed');
});

test('scoreKey: a quote\'s own answer wins, states limit a question\'s, and only keyed intakes count', () => {
  const rows = rowsOf();
  const k = key({ [COMP_ID]: { answer: { value: 'Yes' }, ...by } }, { sample: { [`${COMP_ID}#v0@1`]: { answer: { value: 'No' }, ...by } } });
  const run = scoreKey(rows, k);
  // `kept` and `fixed` are one intake: one answer, its latest quote's.
  assert.equal(run.scored.filter((s) => s.question === COMP_ID).length, 1);
  assert.equal(run.scored.find((s) => s.question === COMP_ID).result, 'wrong');
  // Intake `other` isn't in the key: not scored at all.
  assert.equal(run.scored.some((s) => s.intake === 'other'), false);
  assert.equal(run.quotes, 1);
  const elsewhere = scoreKey(rows, key({ [COMP_ID]: { answer: { value: 'Yes' }, states: ['FL'], ...by } }));
  assert.equal(elsewhere.scored.find((s) => s.question === COMP_ID).result, 'unkeyed');
  // "Depends on the client" without the quote's own answer is not keyed.
  const perQuote = scoreKey(rows, key({ [COMP_ID]: { answer: { perQuote: true }, ...by } }));
  assert.equal(perQuote.scored.find((s) => s.question === COMP_ID).result, 'unkeyed');
  assert.equal(perQuote.total.cells, perQuote.scored.length);
});

test('scoreKey scores the reviewer\'s decided answers apart from those confirmed as proposed', () => {
  const run = scoreKey(rowsOf(), key({
    [COMP_ID]: { answer: { value: 'Yes' }, proposed: true, ...by },
    [COLOR_ID]: { answer: { value: 'Blue' }, ...by },
  }));
  // Both count in every answer; only the typed one is decided.
  assert.deepEqual([run.total.right, run.total.missed], [1, 1]);
  assert.deepEqual([run.decided.cells, run.decided.right, run.decided.missed], [1, 0, 1]);
  assert.equal(run.decidedByCarrier.progressive.missed, 1);
  assert.deepEqual([run.entries, run.proposed], [2, 1]);
});

test('scoreKey leaves test runs out: a keyed intake run again as a test is not its agent\'s answer', () => {
  const rows = rowsOf();
  const k = key({ [COMP_ID]: { answer: { value: 'Yes' }, ...by } });
  // `fixed`, the intake's latest quote, corrected Yes to No; as a test run, `kept` stands for it.
  assert.equal(scoreKey(rows, k).scored.find((s) => s.question === COMP_ID).agent, 'wrong');
  const run = scoreKey(rows, k, { tests: new Set(['fixed']) });
  assert.equal(run.scored.find((s) => s.question === COMP_ID).agent, 'right');
  assert.equal(scoreKey(rows, k, { tests: new Set(['fixed', 'kept']) }).quotes, 0);
});

test('the agents\' final answers are scored apart, typed text only through the intake fields it matched', () => {
  const rows = rowsOf();
  const run = scoreKey(rows, key({ [COMP_ID]: { answer: { value: 'Yes' }, ...by }, [DOB_ID]: { answer: { fromIntake: 'drivers[].dob' }, ...by } }));
  // The intake's latest quote (`fixed`): the agent corrected Yes to No.
  assert.equal(run.scored.find((s) => s.question === COMP_ID).agent, 'wrong');
  assert.equal(run.scored.find((s) => s.question === DOB_ID).agent, 'right');
  assert.equal(run.total.agents.wrong, 1);
  const record = { drivers: [{ dob: '01/02/1980' }] };
  assert.equal(agentVerdict({ group: 'agent', matches: [] }, { value: '01/02/1980', path: 'drivers[0].dob' }, false, record), 'wrong');
  // A value no intake field holds: typing it would match nothing either.
  assert.equal(agentVerdict({ group: 'agent', matches: [] }, { value: 'Zq-77' }, false, record), 'unsure');
  assert.equal(agentVerdict({ group: 'agent', value: 'No' }, { none: 'agent' }, true, record), null);
});

test('keyVerdict and wanted follow the units, yes/no, numbers and dollar amounts', () => {
  assert.equal(unitPath('vehicles[].vin', 'v1@1'), 'vehicles[1].vin');
  assert.equal(unitPath('drivers[].dob', ''), 'drivers[0].dob');
  assert.deepEqual(wanted({ fromIntake: 'drivers[].dob' }, { drivers: [{ dob: '' }] }, 'd0@1'), { none: 'missing', path: 'drivers[0].dob' });
  assert.deepEqual(wanted({ fromIntake: 'drivers[].dob' }, { drivers: [{}, { dob: '1/2/1990' }] }, 'd1@1'), { value: '1/2/1990', path: 'drivers[1].dob' });
  assert.equal(keyVerdict({ kind: 'bool', value: true }, { value: 'Yes' }, true), 'agree');
  assert.equal(keyVerdict({ kind: 'bool', value: false }, { value: true }, true), 'differ');
  assert.equal(keyVerdict({ kind: 'int', value: 800 }, { value: 800 }, true), 'agree');
  // A band is the page's pick: can't tell.
  assert.equal(keyVerdict({ kind: 'int', value: 800 }, { value: 'More than 500 miles' }, true), 'unsure');
  assert.equal(keyVerdict({ kind: 'choice', value: '$1M CSL' }, { value: '$1,000,000 CSL' }, true), 'agree');
  assert.equal(keyVerdict({ kind: 'text', path: 'applicant.name', value: 'Acme' }, { value: 'ACME', path: 'applicant.name' }, false), 'agree');
  assert.equal(keyVerdict({ kind: 'text', path: 'progressive.q1', value: 'Acme Co' }, { value: 'Acme' }, false), 'differ');
});

test('keyCells joins an AmWINS answer recorded without its step to the one step that reads the same', () => {
  const row = (question, session) => ({ question, session, intakeId: 'i1', carrier: 'amwins', page: question.split('|')[1], status: 'value', group: 'kept', detail: { unit: '' } });
  const cells = keyCells([row('amwins|/application/businessauto|any vehicle not owned', 'old'), row('amwins|/application/businessauto › Underwriting|any vehicle not owned', 'new')]);
  assert.deepEqual(cells.map((c) => c.cell), ['amwins|/application/businessauto › Underwriting|any vehicle not owned']);
});

// The coverage steps of the one-address carriers are coverage choices, quote by quote, as
// Progressive's CoveragesRates: AmWINS' Coverages and GEICO's Quote & Coverages.
test('sheetModel asks for the client\'s coverage choices on every carrier\'s coverage page', () => {
  const row = (question) => ({ question, session: 's1', intakeId: 'i1', carrier: question.split('|')[0], page: question.split('|')[1], kind: 'choice', status: 'value', source: 'derived',
    group: 'kept', detail: { unit: '', state: 'FL', businessClass: 'Freight Hauler', record: {}, step: { kind: 'choice', value: 'x' } } });
  const m = sheetModel([row('geico|/quote › Quote & Coverages|ref:CargoLimit'), row('amwins|/application/businessauto › Coverages|cargo'), row('geico|/quote › Vehicles|ref:GiveFarthestOneWayDistance')]);
  assert.deepEqual(Object.fromEntries(m.questions.map((q) => [q.id, q.group])), {
    'geico|/quote › Quote & Coverages|ref:CargoLimit': 'coverage', 'amwins|/application/businessauto › Coverages|cargo': 'coverage', 'geico|/quote › Vehicles|ref:GiveFarthestOneWayDistance': 'derived' });
});

test('sheetModel groups standards, intake fields and the agent\'s questions, and lists the quotes that need their own answer', () => {
  const m = sheetModel(rowsOf().filter((r) => r.session !== 'other'));
  const q = (id) => m.questions.find((x) => x.id === id);
  assert.equal(q(COMP_ID).group, 'standard');
  // The agent answered the standard otherwise: nothing preselected, both offered.
  assert.deepEqual(q(COMP_ID).proposal, { answer: null });
  assert.deepEqual(q(COMP_ID).choose, { rules: 'Yes', agents: [{ text: 'No', n: 1 }] });
  // Where the agent kept it, today's standard is the proposal.
  const kept = sheetModel(rowsOf().filter((r) => r.session === 'kept')).questions.find((x) => x.id === COMP_ID);
  assert.deepEqual(kept.proposal, { answer: { value: 'Yes' } });
  assert.equal(kept.choose, undefined);
  assert.equal(q(DOB_ID).group, 'mapping');
  assert.deepEqual(q(DOB_ID).proposal, { answer: { fromIntake: 'drivers[].dob' } });
  assert.equal(q(COLOR_ID).group, 'agent');
  assert.deepEqual(q(COLOR_ID).proposal, { answer: { agent: true } });
  // The agent corrected the standard in this client's quote: a row of its own, with the agent's answer proposed.
  const comp = m.cells.find((c) => c.question === COMP_ID);
  assert.match(comp.attention.join(' '), /corrected/);
  assert.deepEqual(comp.proposal, { answer: { value: 'No' } });
  // The date of birth matches the intake: nothing to decide per quote.
  assert.deepEqual(m.cells.find((c) => c.question === DOB_ID).attention, []);
  assert.deepEqual(m.cells.find((c) => c.question === DOB_ID).values.map(([p]) => p), ['drivers[0].dob']);
  // Not quote questions: by id only, or a login page.
  assert.equal(m.questions.some((x) => /q:9Z02|9Z02$|Login/.test(x.id)), false);
  assert.deepEqual(m.left, { byId: 1, offQuote: 1 });
  assert.equal(m.intakes.length, 1);
});

test('sheetModel proposes the option a quote ended on for a standard pick that depends on the page\'s options', () => {
  const row = (session, step) => ({
    id: `${session}|progressive|BusinessOwnerInfo|ref:Home.Address`, session, intakeId: 'i1', carrier: 'progressive', page: 'BusinessOwnerInfo', question: 'progressive|BusinessOwnerInfo|ref:Home.Address',
    label: 'Home Address', kind: 'radio', status: 'value', source: 'standard', group: 'kept', result: 'unsure',
    detail: { step, truth: { group: 'kept', value: 'Main St (USDOT Address)' }, record: {}, unit: '', state: 'MD', options: ['Main St (USDOT Address)', 'Enter a different address'] },
  });
  const m = sheetModel([row('s1', { kind: 'first-option', value: 'first option' })]);
  assert.deepEqual(m.questions[0].proposal, { answer: { value: 'Main St (USDOT Address)' } });
  assert.deepEqual(m.cells[0].attention, []);
});

test('the sheet resumes a key and keeps a label from closing its script', () => {
  const k = key({ [COMP_ID]: { answer: { value: 'Yes' }, ...by } });
  const m = sheetModel(rowsOf().filter((r) => r.session !== 'other'), { key: k });
  assert.equal(m.key.questions[COMP_ID].answer.value, 'Yes');
  m.questions[0].label = '</script><script>alert(1)</script>';
  const html = sheetHtml({ generated: '2026-10-20T00:00:00Z', ...m });
  assert.equal(html.includes('<script>alert(1)'), false);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2);
  assert.ok(html.includes('"kind":"tni-answer-key-sheet"'));
});

test('compareKey lists keyed answers whose result changed', () => {
  const before = [{ id: 'a', key: 'right' }, { id: 'b', key: 'missed' }, { id: 'c', key: 'right' }];
  const after = [{ id: 'a', key: 'wrong' }, { id: 'b', key: 'missed' }, { id: 'd', key: 'invented' }];
  assert.deepEqual(compareKey(before, after).map((r) => [r.id, r.wasKey, r.key]), [['a', 'right', 'wrong']]);
});

test('the weekly numbers show the key score only when a key is configured', () => {
  const events = quotes();
  const answerKey = scoreKey(rowsOf(events), key({ [COMP_ID]: { answer: { value: 'Yes' }, proposed: true, ...by }, [COLOR_ID]: { answer: { value: 'Blue' }, ...by } }));
  const s = signals(events, { answerKey });
  const k = s.kpis.answerKey;
  assert.deepEqual([k.quotes, k.all.right, k.all.missed, k.all.invented, k.decided.right, k.decided.missed, k.proposed, k.entries], [1, 1, 1, 0, 0, 1, 1, 2]);
  // Every answer, then the reviewer's decided ones, then the entries accepted as proposed.
  assert.match(markdown(s), /\| Today's rules against TNI's answer key \(1 keyed intake,.*\| 50% · 0 · 1 · 0 \/ 0% · 0 · 1 · 0; 1 of 2 \|/);
  assert.equal(signals(events).kpis.answerKey, null);
  assert.doesNotMatch(markdown(signals(events)), /answer key/);
});

// Post-merge review of #109: the sheet and the benchmark's key score read reviews/test-intakes.txt
// from the working folder (a worktree has none) and never counted fixture intakes as tests; they now
// read the list as the review and the signals do (readTestList).
const root = fileURLToPath(new URL('..', import.meta.url));
const repoList = fs.existsSync(path.join(root, 'reviews', 'test-intakes.txt'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A working folder with four intakes' quotes: three clients' PDFs (the sample with a line of its own
// after its end, so a fingerprint of its own: `agent`, `listed`, `decoy`) and the committed fixture
// itself. The folder's own reviews/test-intakes.txt, which isn't the repository's, names `listed`
// and `decoy`; `list` (for --tests) names `listed` only.
function clients(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-key-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sample = fs.readFileSync(path.join(root, 'test', 'fixtures', 'sample-intake.pdf'));
  const intakes = path.join(dir, 'intakes');
  fs.mkdirSync(intakes);
  const ids = {};
  for (const name of ['agent', 'listed', 'decoy']) {
    const bytes = Buffer.concat([sample, Buffer.from(`\n% ${name}\n`)]);
    fs.writeFileSync(path.join(intakes, `${name}.pdf`), bytes);
    ids[name] = sha(bytes);
  }
  fs.writeFileSync(path.join(intakes, 'fixture.pdf'), sample);
  ids.fixture = sha(sample);
  const events = [];
  let at = Date.parse('2026-10-05T12:00:00Z');
  for (const [session, intakeId] of Object.entries(ids)) {
    const e = (x) => events.push({ id: `${session}${events.length}`, t: new Date(at += 1000).toISOString(), session, intakeId, carrier: 'progressive', ...x });
    e({ type: 'intake_loaded', carrier: undefined, state: 'MD', businessClass: 'Expediter' });
    e({ type: 'fill_field', page: 'AddVehicle', view: 't1:v0', q: '2CCC', key: 'ref:RiskInput.CompCollIndicator', label: COMP, controlKind: 'radio', result: 'filled', path: 'progressive.q2CCC', shown: 'Yes' });
  }
  const data = path.join(dir, 'events.jsonl');
  fs.writeFileSync(data, events.map((e) => JSON.stringify(e)).join('\n'));
  fs.mkdirSync(path.join(dir, 'reviews'));
  fs.writeFileSync(path.join(dir, 'reviews', 'test-intakes.txt'), `${ids.listed.slice(0, 8)}\n${ids.decoy.slice(0, 8)}\n`);
  const list = path.join(dir, 'tests.txt');
  fs.writeFileSync(list, `# the maintainer's test intake\n${ids.listed.slice(0, 12)}\n`);
  const short = path.join(dir, 'short.txt');
  fs.writeFileSync(short, 'abc\n');
  const run = (script, ...args) => spawnSync(process.execPath, [path.join(root, 'scripts', script), data, '--intakes', intakes, ...args], { cwd: dir, encoding: 'utf8' });
  return { dir, ids, list, short, run };
}

// The refusals the review makes: no value, a missing file, a short or non-hex fingerprint.
function refusesBadLists(c, script, out, ...args) {
  for (const bad of [['--tests'], ['--tests', '--out'], ['--tests', path.join(c.dir, 'missing.txt')], ['--tests', c.short]]) {
    const r = c.run(script, ...args, '--out', out, ...bad);
    assert.equal(r.status, 1, `${bad.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /needs a value|no such file|at least 8 hex/);
  }
  assert.ok(!fs.existsSync(out), 'nothing written from a bad list');
}

test('the sheet reads the test-run list as the review does, and says on the sheet when it has none', (t) => {
  const c = clients(t);
  const sheet = (file) => {
    const html = fs.readFileSync(file, 'utf8');
    return JSON.parse(/<script type="application\/json" id="model">([\s\S]*?)<\/script>/.exec(html)[1]);
  };
  const keyed = (model) => model.intakes.map((i) => Object.keys(c.ids).find((k) => c.ids[k] === i.id)).sort();
  // The repository's list, wherever it runs (never the working folder's), and the fixture's quote.
  const plain = c.run('answer-key-sheet.mjs', '--out', path.join(c.dir, 'plain.html'));
  assert.equal(plain.status, 0, plain.stderr);
  const model = sheet(path.join(c.dir, 'plain.html'));
  assert.deepEqual(keyed(model), ['agent', 'decoy', 'listed'], 'the fixture\'s quote left out; the working folder\'s list not read');
  assert.equal(model.noTestList, repoList ? null : NO_TEST_LIST);
  if (repoList) assert.doesNotMatch(plain.stderr, /No test-run list/, 'the repository\'s list was found');
  else assert.ok(plain.stderr.includes(`Warning: ${NO_TEST_LIST}`));
  // The page shows the warning it was given.
  assert.match(fs.readFileSync(path.join(c.dir, 'plain.html'), 'utf8'), /getElementById\('noTestList'\)\.textContent = M\.noTestList/);
  // --tests: the listed quote is a test too, and nothing to warn about.
  const listed = c.run('answer-key-sheet.mjs', '--tests', c.list, '--out', path.join(c.dir, 'listed.html'));
  assert.equal(listed.status, 0, listed.stderr);
  const withList = sheet(path.join(c.dir, 'listed.html'));
  assert.deepEqual([keyed(withList), withList.noTestList], [['agent', 'decoy'], null]);
  assert.doesNotMatch(listed.stderr, /No test-run list/);
  assert.match(listed.stdout, /\(2 test-run sessions left out;/);
  refusesBadLists(c, 'answer-key-sheet.mjs', path.join(c.dir, 'bad.html'));
});

test('the benchmark scores the key with the test-run list the review reads, and says when it has none', (t) => {
  const c = clients(t);
  const keyFile = path.join(c.dir, 'key.json');
  fs.writeFileSync(keyFile, JSON.stringify({ kind: 'tni-answer-key', version: 1, questions: { [COMP_ID]: { answer: { value: 'Yes' }, ...by } }, quotes: Object.fromEntries(Object.values(c.ids).map((id) => [id, {}])) }));
  const line = (md) => /4 intakes keyed, (\d+) with recorded quotes here; test runs left out \((\d+) test-run sessions\)/.exec(md)?.slice(1).map(Number);
  // The repository's list, wherever it runs (never the working folder's), and the fixture's quote.
  const plain = c.run('benchmark.mjs', '--key', keyFile, '--out', path.join(c.dir, 'plain.md'));
  assert.equal(plain.status, 0, plain.stderr);
  const md = fs.readFileSync(path.join(c.dir, 'plain.md'), 'utf8');
  assert.deepEqual(line(md), [3, 1], 'the fixture\'s quote left out; the working folder\'s list not read');
  if (repoList) assert.doesNotMatch(`${plain.stderr}${md}`, /No test-run list/, 'the repository\'s list was found');
  else {
    assert.ok(plain.stderr.includes(`Warning: ${NO_TEST_LIST}`));
    assert.ok(md.includes(`**${NO_TEST_LIST}**`));
  }
  // --tests: the listed quote is a test too, and nothing to warn about.
  const listed = c.run('benchmark.mjs', '--key', keyFile, '--tests', c.list, '--out', path.join(c.dir, 'listed.md'));
  assert.equal(listed.status, 0, listed.stderr);
  const withList = fs.readFileSync(path.join(c.dir, 'listed.md'), 'utf8');
  assert.deepEqual(line(withList), [2, 2]);
  assert.doesNotMatch(`${listed.stderr}${withList}`, /No test-run list/);
  refusesBadLists(c, 'benchmark.mjs', path.join(c.dir, 'bad.md'), '--key', keyFile);
  // Without a key the list isn't read: no warning, nothing scored.
  const unkeyed = c.run('benchmark.mjs', '--out', path.join(c.dir, 'unkeyed.md'));
  assert.equal(unkeyed.status, 0, unkeyed.stderr);
  assert.doesNotMatch(`${unkeyed.stderr}${fs.readFileSync(path.join(c.dir, 'unkeyed.md'), 'utf8')}`, /No test-run list|answer key/);
});
