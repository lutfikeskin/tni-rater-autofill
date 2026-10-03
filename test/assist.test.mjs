import test from 'node:test';
import assert from 'node:assert/strict';
import { collectItems, buildRequest, parseResponse, callModel, outputText, neverReason, AssistError, LEAVE, DEFAULT_MODEL, assistContextKey } from '../src/ai/assist.js';

test('AI cache separates active drivers, vehicles and edited intake answers', () => {
  const intake = { vehicles: [{ value: 20000 }, { value: 40000 }] };
  const key = assistContextKey(intake, { drivers: 0, vehicles: 0 });
  assert.equal(key, assistContextKey(structuredClone(intake), { drivers: 0, vehicles: 0 }));
  assert.notEqual(key, assistContextKey(intake, { drivers: 0, vehicles: 1 }));
  assert.notEqual(key, assistContextKey(intake, { drivers: 1, vehicles: 0 }));
  intake.vehicles[0].value = 30000;
  assert.notEqual(key, assistContextKey(intake, { drivers: 0, vehicles: 0 }));
});

test('lookup identity mismatch requires agent review, never an AI answer', () => {
  const { items, blocked } = collectItems([{ noData: [{ key: '20F', label: 'Does this DOT belong to you?',
    controlKind: 'radio', options: ['Yes', 'No'], reviewOnly: true }] }]);
  assert.equal(items.length, 0);
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].why, /review/i);
});

// Synthetic fill report and intake: no real client data.
const record = {
  applicant: { name: 'Sample Expedite LLC', mc: '123456' },
  operations: { radius: 600, businessClass: 'Expediter' },
  drivers: [{ first: 'Jordan', last: 'Avery', dob: '02/03/1988' }],
  vehicles: [{ type: 'Van' }],
  coverage: {},
};

const frames = [{
  unknown: [
    { key: 'A1', q: 'A1', label: 'Does the business haul goods for others?', controlKind: 'radio', required: true, options: ['Yes', 'No'], current: null, section: 'Operations' },
    { key: 'A2', q: 'A2', label: 'Order MVR now?', controlKind: 'radio', options: ['Yes', 'No'] },
    { key: 'A3', q: 'A3', label: 'VIN', controlKind: 'text', options: [] },
    { key: 'A4', q: 'A4', label: 'Years in business', controlKind: 'text', options: [] },
  ],
  failed: [
    { key: 'B1', q: 'B1', label: 'Commodity', controlKind: 'select', reason: 'no option matches "Freight"', options: ['Consumer Goods', 'Building Materials'] },
    // Same question listed twice in one report: asked once.
    { key: 'A1', q: 'A1', label: 'Does the business haul goods for others?', controlKind: 'radio', options: ['Yes', 'No'] },
  ],
  noData: [{ key: 'C1', q: 'C1', label: 'Vehicle has no equipment', controlKind: 'checkbox', note: 'n/a' }],
  leftRequired: [{ key: 'D1', q: 'D1', label: 'Business type', controlKind: 'select', options: [] }],
}];

test('leftovers become one item each; MVR orders and typed identifiers are never sent', () => {
  const { items, blocked } = collectItems(frames);
  assert.deepEqual(items.map((x) => x.key), ['B1', 'A1', 'A4', 'C1', 'D1']);
  assert.deepEqual(blocked.map((x) => x.key).sort(), ['A2', 'A3']);
  assert.deepEqual(items.find((x) => x.key === 'C1').options, ['checked', 'unchecked']);
  // A dropdown whose options weren't visible can only get a tip.
  assert.equal(items.find((x) => x.key === 'D1').applyable, false);
  assert.equal(items.find((x) => x.key === 'A4').applyable, true);
  assert.ok(neverReason({ label: 'Exclude this driver?' }));
  assert.ok(neverReason({ label: 'I authorize Progressive to obtain reports' }));
  assert.equal(neverReason({ label: 'Does the customer have a USDOT number?', controlKind: 'radio' }), null);
});

test('request: strict schema whose choices are the field options plus leave', () => {
  const { items } = collectItems(frames);
  const body = buildRequest(items, { record, carrier: 'progressive', page: 'AddVehicle' });
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.store, false);
  assert.match(body.instructions, /Truckers National Insurance/);
  const format = body.text.format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.strict, true);
  const answers = format.schema.properties.answers;
  assert.deepEqual(answers.required, items.map((x) => x.id));
  assert.equal(answers.additionalProperties, false);
  const a1 = items.find((x) => x.key === 'A1').id;
  assert.deepEqual(answers.properties[a1].properties.choice.enum, ['Yes', 'No', LEAVE]);
  for (const prop of Object.values(answers.properties)) {
    assert.equal(prop.additionalProperties, false);
    assert.deepEqual([...prop.required].sort(), Object.keys(prop.properties).sort());
  }
  // Text boxes get free text (checked afterwards), not an enum.
  const a4 = items.find((x) => x.key === 'A4').id;
  assert.equal(answers.properties[a4].properties.choice.enum, undefined);
  const sent = JSON.parse(body.input[0].content);
  assert.equal(sent.intake.applicant.mc, '123456');
  assert.equal(sent.questions.length, items.length);
});

test('request: past the enum budget, big option lists become strings checked in code', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ key: `K${i}`, label: `Question ${i}`, controlKind: 'select', options: Array.from({ length: 80 }, (_, j) => `Option ${j}`) }));
  const { items } = collectItems([{ unknown: many }]);
  const props = buildRequest(items, { record }).text.format.schema.properties.answers.properties;
  const enums = Object.values(props).filter((p) => p.properties.choice.enum).length;
  assert.ok(enums >= 10 && enums < 12, `got ${enums}`);
});

const reply = (answers, extra = {}) => ({
  status: 'completed',
  output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ answers }) }] }],
  usage: { input_tokens: 3000, output_tokens: 200 },
  ...extra,
});

test('response: options are enforced, cited intake paths are checked, text is never selected by the AI', () => {
  const { items } = collectItems(frames);
  const id = (key) => items.find((x) => x.key === key).id;
  const out = parseResponse(reply({
    [id('A1')]: { tip: 'MC number means for-hire.', basis: 'intake', intakePath: 'applicant.mc', confidence: 'high', choice: 'yes' },
    [id('B1')]: { tip: 'General freight.', basis: 'tni_rule', intakePath: null, confidence: 'high', choice: 'Other Consumer Goods' },
    [id('A4')]: { tip: 'Not on the intake.', basis: 'intake', intakePath: 'operations.yearsInBusiness', confidence: 'high', choice: '5' },
    [id('C1')]: { tip: 'TNI ticks it.', basis: 'tni_rule', intakePath: null, confidence: 'high', choice: 'checked' },
    [id('D1')]: { tip: 'Pick For Hire Trucking.', basis: 'tni_rule', intakePath: null, confidence: 'medium', choice: LEAVE },
  }), items, record);
  const by = Object.fromEntries(out.map((x) => [x.key, x]));
  // Case-insensitive match is snapped to the page's own option text.
  assert.equal(by.A1.choice, 'Yes');
  assert.equal(by.A1.autoOk, true);
  // An option the page doesn't offer is never passed on.
  assert.equal(by.B1.leave, true);
  assert.equal(by.B1.autoOk, false);
  assert.match(by.B1.checks[0], /isn't one of the options/);
  // A made-up intake path loses the "intake" basis and high confidence; text is never auto.
  assert.equal(by.A4.basis, 'judgement');
  assert.equal(by.A4.confidence, 'medium');
  assert.equal(by.A4.autoOk, false);
  assert.equal(by.C1.autoOk, true);
  assert.equal(by.D1.leave, true);
});

test('response: the AI may select medium-confidence choices, never low-confidence ones', () => {
  const { items } = collectItems([{ unknown: [
    { key: 'M', label: 'Tows for others?', controlKind: 'radio', options: ['Yes', 'No'] },
    { key: 'L', label: 'Seasonal business?', controlKind: 'radio', options: ['Yes', 'No'] },
  ] }]);
  const [m, l] = parseResponse(reply({
    f1: { tip: '', basis: 'judgement', intakePath: null, confidence: 'medium', choice: 'No' },
    f2: { tip: '', basis: 'judgement', intakePath: null, confidence: 'low', choice: 'No' },
  }), items, record);
  assert.equal(m.autoOk, true);
  assert.equal(l.autoOk, false);
});

test('response: an answer the page already shows is not re-selected automatically', () => {
  const { items } = collectItems([{ unknown: [{ key: 'X', label: 'Hauls for hire?', controlKind: 'radio', options: ['Yes', 'No'], current: 'Yes' }] }]);
  const [x] = parseResponse(reply({ f1: { tip: '', basis: 'tni_rule', intakePath: null, confidence: 'high', choice: 'Yes' } }), items, record);
  assert.equal(x.autoOk, false);
});

test('refusals, cut-off and malformed answers become messages for the agent', () => {
  assert.throws(() => outputText({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), AssistError);
  assert.throws(() => outputText({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }), /cut off/);
  assert.throws(() => parseResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{oops' }] }] }, [], record), /valid JSON/);
});

test('callModel posts to the Responses API with the key and explains HTTP errors', async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => reply({}) }; };
  await callModel({ apiKey: 'sk-test', body: { model: 'gpt-6-luna' }, fetchImpl: ok });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  const failing = (status) => async () => ({ ok: false, status, json: async () => ({ error: { message: 'detail' } }) });
  await assert.rejects(callModel({ apiKey: 'k', body: { model: 'm' }, fetchImpl: failing(401) }), /API key was refused/);
  await assert.rejects(callModel({ apiKey: 'k', body: { model: 'gpt-x' }, fetchImpl: failing(404) }), /gpt-x/);
  await assert.rejects(callModel({ apiKey: 'k', body: {}, fetchImpl: failing(429) }), /rate-limited/);
  await assert.rejects(callModel({ apiKey: '', body: {}, fetchImpl: ok }), /No API key/);
  await assert.rejects(callModel({ apiKey: 'k', body: {}, fetchImpl: async () => { throw new TypeError('fetch failed'); } }), /Can't reach/);
});
