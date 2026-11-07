import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { learn } from '../scripts/lib/learn.mjs';
import { NONE, intakeFields, parseProposal, proposalRequest, proposeRules, proposalsMarkdown, scoreProposal } from '../scripts/lib/proposals.mjs';
import { DEFAULT_MODEL } from '../src/ai/luna.js';
import { rulebookFor } from '../src/ai/tni-rules.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const noRules = [{ id: 'progressive', rules: [], useGenericRules: false }];

// Five quotes of five intakes, each leaving these questions to the agent (`unfamiliar`):
//   9B01 a pick agents split on (3 Yes, 2 No): no standard, one state, so no suggestion
//   9B02 a pick agents always answer No: a possible standard, already a suggestion
//   9B03 a text box whose typed answer matched the drivers' date of birth in 3 of 5: below a mapping
//   9B04 an attestation agents never answered here
function week() {
  const events = [];
  let t = Date.parse('2026-11-02T12:00:00Z');
  const e = (session, x) => events.push({ id: `${session}-${events.length}`, t: new Date(t += 1000).toISOString(), session, carrier: 'progressive', intakeId: `intake${session}`, ...x });
  for (let i = 0; i < 5; i++) {
    const s = `s${i}`;
    e(s, { type: 'intake_loaded', carrier: undefined, state: 'VA' });
    const left = (q, label, controlKind) => e(s, { type: 'fill_field', page: 'MoreAboutBusiness', q, label, controlKind, result: 'unfamiliar' });
    left('9B01', 'Any team drivers?', 'radio');
    left('9B02', 'Hauls for a single shipper?', 'radio');
    left('9B03', 'Youngest driver birth date', 'text');
    left('9B04', 'I certify the answers are true', 'checkbox');
    e(s, { type: 'field_change', page: 'MoreAboutBusiness', q: '9B01', label: 'Any team drivers?', kind: 'radio', by: 'agent', to: i < 3 ? 'Yes' : 'No' });
    e(s, { type: 'field_change', page: 'MoreAboutBusiness', q: '9B02', label: 'Hauls for a single shipper?', kind: 'radio', by: 'agent', to: 'No' });
    e(s, { type: 'field_change', page: 'MoreAboutBusiness', q: '9B03', label: 'Youngest driver birth date', kind: 'text', by: 'agent', change: 'entered', matchesIntake: i < 3 ? ['drivers[0].dob'] : [] });
  }
  return events;
}

const response = (data) => ({ status: 'completed', model: DEFAULT_MODEL, usage: { input_tokens: 900, output_tokens: 60 },
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(data) }] }] });
const proposal = (x) => ({ kind: 'agents', intakePath: NONE, answer: NONE, mapping: [], ruleIds: [], explanation: 'Depends on the client.', ...x });

test('learning: a question left to the agent repeatedly that no suggestion answers is a rule-proposal candidate, with the agents\' answers', () => {
  const { suggestions, undecided } = learn(week(), { carriers: noRules, minIntakes: 5 });
  assert.deepEqual(suggestions.standard.map((s) => s.q), ['9B02'], 'the always-No question is a possible standard, as before');
  assert.deepEqual(undecided.map((c) => c.q).sort(), ['9B01', '9B03', '9B04'], 'the split pick, the text box below a mapping and the unanswered attestation');
  const team = undecided.find((c) => c.q === '9B01');
  assert.equal(team.left, 5);
  assert.equal(team.intakes, 5);
  assert.equal(team.answers, 5);
  assert.deepEqual(team.agentAnswers.map(({ value, count }) => [value, count]), [['Yes', 3], ['No', 2]]);
  const dob = undecided.find((c) => c.q === '9B03');
  assert.equal(dob.typed, 5);
  assert.deepEqual(dob.typedMatches.map(({ value, count }) => [value, count]), [['drivers[].dob', 3], ['(no intake match)', 2]], 'paths with the row dropped, never values');
  assert.equal(learn(week(), { carriers: noRules, minIntakes: 6 }).undecided.length, 0, 'fewer intake PDFs than the minimum: no candidate');
});

test('rule proposals: the request offers only the schema\'s paths, the answers seen and TNI\'s rule ids, with no intake values', () => {
  const [team] = learn(week(), { carriers: noRules, minIntakes: 5 }).undecided.filter((c) => c.q === '9B01');
  const req = proposalRequest(team);
  const { schema } = req.body.text.format;
  assert.equal(req.body.text.format.strict, true);
  assert.equal(req.body.store, false);
  assert.deepEqual(schema.properties.kind.enum, ['intake-path', 'standard-candidate', 'agents']);
  assert.deepEqual(schema.properties.answer.enum, ['Yes', 'No', NONE]);
  assert.deepEqual(schema.properties.intakePath.enum, [...intakeFields().map((f) => f.path), NONE]);
  assert.deepEqual(schema.properties.ruleIds.items.enum, [...rulebookFor('progressive').map((r) => r.id), NONE]);
  const state = JSON.parse(req.body.input[0].content);
  assert.deepEqual(state.agentsFinalAnswers, [{ value: 'Yes', count: 3 }, { value: 'No', count: 2 }]);
  assert.equal(state.question.label, 'Any team drivers?');
  assert.ok(!('record' in state) && !('intake' in state), 'no intake values');
  assert.deepEqual(proposalRequest(team, { limit: 100 }), { tooLarge: true });
});

test('rule proposals: code checks each proposal and refuses one that invents, mixes kinds or makes an attestation a standard', () => {
  const undecided = learn(week(), { carriers: noRules, minIntakes: 5 }).undecided;
  const team = undecided.find((c) => c.q === '9B01'), dob = undecided.find((c) => c.q === '9B03'), cert = undecided.find((c) => c.q === '9B04');
  const req = proposalRequest(team), ruleId = req.ids[0];
  const ok = parseProposal(response(proposal({ kind: 'standard-candidate', answer: 'Yes', ruleIds: [ruleId] })), team, req);
  assert.deepEqual(ok, { kind: 'standard-candidate', intakePath: null, answer: 'Yes', mapping: [], ruleIds: [ruleId], explanation: 'Depends on the client.' });
  const refused = (x, c = team, r = req) => assert.throws(() => parseProposal(response(proposal(x)), c, r), /can't stand/);
  refused({ kind: 'standard-candidate', answer: 'Maybe' });
  refused({ kind: 'standard-candidate' });
  refused({ kind: 'intake-path', intakePath: 'drivers[].shoeSize' });
  refused({ kind: 'intake-path', intakePath: 'drivers[].dob', answer: 'Yes' });
  refused({ kind: 'intake-path', intakePath: 'applicant.ownerDrives', mapping: [{ from: 'maybe', to: 'Yes' }] });
  refused({ kind: 'intake-path', intakePath: 'applicant.ownerDrives', mapping: [{ from: 'true', to: 'Yes' }, { from: 'true', to: 'No' }] });
  refused({ kind: 'intake-path', intakePath: 'applicant.name', mapping: [{ from: 'x', to: 'Yes' }] });
  refused({ kind: 'agents', answer: 'Yes' });
  refused({ kind: 'agents', ruleIds: ['general.made-up'] });
  refused({ kind: 'agents', explanation: '' });
  refused({ kind: 'agents', explanation: 'x'.repeat(401) });
  assert.throws(() => parseProposal(response({ kind: 'agents' }), team, req), /can't stand/);
  const mapped = parseProposal(response(proposal({ kind: 'intake-path', intakePath: 'applicant.ownerDrives', mapping: [{ from: 'true', to: 'Yes' }, { from: 'false', to: 'No' }] })), team, req);
  assert.deepEqual(mapped.mapping, [{ from: 'true', to: 'Yes' }, { from: 'false', to: 'No' }]);
  const certReq = proposalRequest(cert);
  assert.deepEqual(certReq.answers, [], 'no option or answer seen');
  refused({ kind: 'standard-candidate', answer: 'true' }, cert, certReq);
  // An attestation or a client fact is never a standard, even with an answer the page offers.
  assert.throws(() => parseProposal(response(proposal({ kind: 'standard-candidate', answer: 'Yes' })), { ...team, label: 'I certify the answers are true' }, req), /a standard for an attestation/);
  assert.throws(() => parseProposal(response(proposal({ kind: 'standard-candidate', answer: 'Yes' })), { ...team, label: 'Any MCS-90 filing?' }, req), /a standard for a client fact/);
  assert.equal(parseProposal(response(proposal({})), cert, certReq).kind, 'agents');
  assert.equal(parseProposal(response(proposal({ kind: 'intake-path', intakePath: 'drivers[].dob' })), dob, proposalRequest(dob)).intakePath, 'drivers[].dob');
});

test('rule proposals: each is scored by its agreement with the agents\' final answers, where those can tell', () => {
  const undecided = learn(week(), { carriers: noRules, minIntakes: 5 }).undecided;
  const team = undecided.find((c) => c.q === '9B01'), dob = undecided.find((c) => c.q === '9B03'), cert = undecided.find((c) => c.q === '9B04');
  assert.deepEqual(scoreProposal({ kind: 'standard-candidate', answer: 'Yes' }, team), { agreement: 0.6, agreed: 3, of: 5, basis: "the agents' final answers" });
  assert.equal(scoreProposal({ kind: 'standard-candidate', answer: 'No' }, team).agreement, 0.4);
  assert.equal(scoreProposal({ kind: 'intake-path', intakePath: 'drivers[].dob' }, dob).agreement, 0.6, 'the typed answers that matched it');
  assert.equal(scoreProposal({ kind: 'intake-path', intakePath: 'applicant.ownerDrives' }, team).agreement, null, "a pick's field needs the intakes' values");
  assert.equal(scoreProposal({ kind: 'agents' }, cert).agreement, null);
  assert.equal(scoreProposal({ kind: 'standard-candidate', answer: 'true' }, cert).agreement, null, 'no agent answer to compare');
});

test('rule proposals: drafted one request at a time; a failed or refused one is listed as not drafted, and the brief asks for TNI\'s decision', async () => {
  const result = learn(week(), { carriers: noRules, minIntakes: 5 });
  const bodies = [];
  const answers = { '9B01': proposal({ kind: 'standard-candidate', answer: 'Yes', explanation: 'Most agents said Yes.' }), '9B03': proposal({ kind: 'intake-path', intakePath: 'drivers[].dob' }) };
  const call = async ({ apiKey, body }) => {
    assert.equal(apiKey, 'test-key');
    bodies.push(body);
    const label = JSON.parse(body.input[0].content).question.label;
    if (label.startsWith('I certify')) throw new Error('Luna is rate-limited. Try again shortly.');
    return response(answers[result.undecided.find((c) => c.label === label).q]);
  };
  const drafted = await proposeRules(result.undecided, { apiKey: 'test-key', call });
  assert.equal(bodies.length, 3);
  assert.equal(drafted.usage.modelCalls, 2);
  assert.equal(drafted.usage.tokensIn, 1800);
  const md = proposalsMarkdown(result.undecided, drafted, { generated: '2026-11-07', quotes: result.quotes, intakes: result.intakes });
  assert.match(md, /^# Rule proposals for questions left to the agent \(3\)/);
  assert.match(md, /nothing is applied or promoted/);
  assert.match(md, /Proposal \(standard-candidate\): "Yes"\. Agreement: 3 of 5, the agents' final answers \(60%\)\./);
  assert.match(md, /Decide: Is "Yes" TNI's standard here\? If so, record it in TNI's rulebook/);
  assert.match(md, /Proposal \(intake-path\): `drivers\[\]\.dob`\. Agreement: 3 of 5, the typed answers that matched the field/);
  assert.match(md, /Not drafted: Luna is rate-limited/);
  assert.match(md, /Agreement over the scored proposals: 6 of 10 answers \(60%\)/);
  const limited = await proposeRules(result.undecided, { apiKey: 'test-key', call, max: 1 });
  assert.equal(limited.notDrafted, 2);
  const listed = proposalsMarkdown(result.undecided, null);
  assert.match(listed, /Not drafted: run with `--live`/);
  assert.doesNotMatch(listed, /Proposal \(/);
});

test('rule proposals: the script lists candidates without --live and sends nothing; --live needs a key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposals-'));
  const log = path.join(dir, 'usage.jsonl');
  fs.writeFileSync(log, week().map((e) => JSON.stringify(e)).join('\n'));
  const tests = path.join(dir, 'tests.txt');
  fs.writeFileSync(tests, '');
  const run = (args, env = {}) => execFileSync(process.execPath, [path.join(ROOT, 'scripts/rule-proposals.mjs'), log, '--tests', tests, ...args],
    { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const text = run([]);
  assert.match(text, /Rule proposals for questions left to the agent \(\d+\)/);
  assert.match(text, /Not drafted: run with `--live`/);
  assert.throws(() => run(['--live']), /OPENAI_API_KEY/);
  assert.throws(() => run(['--max', '0']), /--max needs a whole number/);
  assert.throws(() => run(['--bogus']), /Unknown option --bogus/);
  for (const bad of ['abc', '0', '5']) assert.throws(() => run(['--threshold', bad]), /--threshold needs a share above 0 and at most 1/, bad);
  assert.match(run(['--threshold', '1']), /Rule proposals for questions left to the agent/);
  fs.rmSync(dir, { recursive: true, force: true });
});
