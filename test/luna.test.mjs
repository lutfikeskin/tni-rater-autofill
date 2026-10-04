import test from 'node:test';
import assert from 'node:assert/strict';
import { collectItems, AssistError, LEAVE } from '../src/ai/assist.js';
import { buildRequest, parseResponse, buildVerification, verifyResponse, suggest, callModel, responseData,
  DEFAULT_MODEL, API_URL } from '../src/ai/luna.js';
import { settingsFrom } from '../src/ai/providers.js';

const context = { carrier: 'geico', page: 'operations', active: { drivers: 0, vehicles: 0 },
  record: { operations: { hazPlacard: false }, drivers: [{ licenseNumber: 'private-identifier' }, { name: 'inactive-person' }], vehicles: [] } };
const items = collectItems([{ unknown: [{ key: 'haz', label: 'Hazardous materials requiring placards?', controlKind: 'select', options: ['Yes', 'No'], current: '' }] }]).items;
const envelope = data => ({ status: 'completed', model: DEFAULT_MODEL,
  output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(data) }] }],
  usage: { input_tokens: 100, output_tokens: 30 } });
const answer = (body, overrides = {}) => {
  const state = JSON.parse(body.input[0].content);
  const source = Object.keys(state.sources).find(k => state.sources[k].path === 'operations.hazPlacard');
  return envelope({ decisions: { f1: { option: 'o1', sourceIds: [source], explanation: 'The intake explicitly says No.', missingInformation: [], conflicts: [], ...overrides } } });
};
const questions = count => Array.from({ length: count }, (_, i) => ({ ...items[0], id: `f${i + 1}`, key: `haz${i + 1}` }));
const groupAnswer = (body, leave = false) => {
  const state = JSON.parse(body.input[0].content);
  const source = Object.keys(state.sources).find(k => state.sources[k].path === 'operations.hazPlacard');
  return envelope({ decisions: Object.fromEntries(Object.keys(state.fields).map(id => [id, {
    option: leave ? LEAVE : 'o1', sourceIds: leave ? [] : [source], explanation: 'Explicit No.', missingInformation: [], conflicts: [],
  }])) });
};
const groupCheck = body => envelope({ decisions: Object.fromEntries(Object.keys(JSON.parse(body.input[0].content).proposed)
  .map(id => [id, { supported: true }])) });

test('Luna requests fixed reasoning model and strict schema without tools or provider storage', () => {
  const body = buildRequest(items, context), wire = JSON.stringify(body);
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.text.verbosity, 'low');
  assert.equal(body.max_output_tokens, 4096);
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, undefined);
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.equal(body.tools, undefined);
  assert.equal(wire.includes('private-identifier'), false);
  assert.equal(wire.includes('inactive-person'), false);
  assert.deepEqual(body.text.format.schema.properties.decisions.properties.f1.properties.option.enum, ['o0', 'o1', LEAVE]);
  assert.deepEqual(body.text.format.schema.properties.decisions.properties.f1.properties.sourceIds, { $ref: '#/$defs/citations' });
  assert.deepEqual(body.text.format.schema.$defs.citations.items.enum, [...Object.keys(JSON.parse(body.input[0].content).sources), LEAVE]);
  assert.equal(body.text.format.schema.$defs.citations.maxItems, 4);
  assert.match(body.instructions, /Missing information is never evidence of No/);
});

test('explicit No becomes eligible only after evidence verification, without fabricated confidence', () => {
  const body = buildRequest(items, context), [x] = parseResponse(answer(body), items, body);
  assert.equal(x.choice, 'No');
  assert.equal(x.intakePath, 'operations.hazPlacard');
  assert.equal(x.evidence.value, false);
  assert.equal(x.leave, false);
  assert.equal(x.autoOk, false);
  assert.equal(x.confidence, null);
  const verified = verifyResponse(envelope({ decisions: { f1: { supported: true } } }), [x])[0];
  assert.equal(verified.verified, true);
  assert.equal(verified.autoOk, true);
  assert.equal(verified.confidence, null);
});

test('verified choices keep numeric, identity, explicit review and unchanged fields manual', () => {
  const body = buildRequest(items, context), [parsed] = parseResponse(answer(body), items, body);
  const checked = envelope({ decisions: { f1: { supported: true } } });
  for (const metadata of [{ manualOnly: true }, { reviewOnly: true }, { applyable: false },
    { fieldType: 'number' }, { fieldType: 'numeric' }, { fieldType: 'date' }, { fieldType: 'limit' },
    { fieldType: 'identity' }, { fieldType: 'identifier' }, { fieldType: null, valueType: 'date' },
    { fieldType: null, semanticType: 'identity' }, { label: 'Annual distance' }, { label: 'Liability CSL' },
    { label: 'Does VIN belong to this vehicle?' }, { label: 'Driver exclusions?' }, { section: 'Billing' },
    { current: ' no ' }, { controlKind: 'text' }, { model: 'unapproved-model' }, { options: ['Yes'] }, { evidenceSources: [] }]) {
    const [x] = verifyResponse(checked, [{ ...parsed, ...metadata }]);
    assert.equal(x.autoOk, false, JSON.stringify(metadata));
  }
});

test('verified radio and checkbox choices can be selected automatically', () => {
  const checked = envelope({ decisions: { f1: { supported: true } } });
  for (const controlKind of ['radio', 'checkbox']) {
    const fields = collectItems([{ unknown: [{ key: 'haz', label: 'Hazardous materials requiring placards?', controlKind,
      options: ['Yes', 'No'], current: '' }] }]).items;
    const body = buildRequest(fields, context), parsed = parseResponse(answer(body), fields, body);
    assert.equal(verifyResponse(checked, parsed)[0].autoOk, true);
  }
});

test('missing evidence, conflicts and incomplete facts preserve abstention', () => {
  const body = buildRequest(items, context);
  for (const override of [{ sourceIds: [] }, { sourceIds: ['invented'] }, { sourceIds: ['__proto__'] }, { sourceIds: ['constructor'] }, { sourceIds: [LEAVE] },
    { missingInformation: ['Customer confirmation required'] }, { conflicts: ['Notes contradict the checkbox'] }, { option: LEAVE }]) {
    const [x] = parseResponse(answer(body, override), items, body);
    assert.equal(x.leave, true);
    assert.equal(x.choice, null);
    assert.equal(x.autoOk, false);
  }
});

test('invalid choices, extra decisions and malformed types fail closed', () => {
  const body = buildRequest(items, context);
  for (const override of [{ option: 'o99' }, { sourceIds: 's1' }, { explanation: null }, { conflicts: [1] }, { confidence: 1 }]) {
    assert.throws(() => parseResponse(answer(body, override), items, body), AssistError);
  }
  assert.throws(() => parseResponse(envelope({ decisions: {} }), items, body), AssistError);
  assert.throws(() => parseResponse(envelope({ decisions: { f1: {}, f2: {} } }), items, body), AssistError);
});

test('multiple citations remain visible without attributing support to the first intake path', () => {
  const body = buildRequest(items, { ...context, record: { ...context.record, operations: { hazPlacard: false, notes: 'Explicitly no placarded hauling.' } } });
  const state = JSON.parse(body.input[0].content);
  const ids = Object.keys(state.sources).filter(id => state.sources[id].basis === 'intake');
  const [x] = parseResponse(answer(body, { sourceIds: ids }), items, body);
  assert.equal(x.intakePath, null);
  assert.equal(x.evidenceSources.length, 2);
  assert.deepEqual(x.evidenceSources.map(x => x.path), ['operations.hazPlacard', 'operations.notes']);
});

test('incomplete, refused, wrong-model and tool-call responses never yield an answer', () => {
  const body = buildRequest(items, context), good = answer(body);
  for (const json of [{ ...good, status: 'incomplete' }, { ...good, model: 'other-model' },
    { ...good, output: [{ type: 'function_call', arguments: '{}' }] },
    { ...good, output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'private-input' }] }] },
    { ...good, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'invalid' }] }] }]) {
    assert.throws(() => responseData(json), AssistError);
  }
});

test('restricted fields cannot be submitted directly to Luna', () => {
  for (const label of ['Driver exclusions?', 'Order MVR?', 'Signature authorization']) {
    assert.throws(() => buildRequest([{ ...items[0], label }], context), AssistError);
  }
});

test('second evidence check rejects unsupported choices and mismatched schemas', () => {
  const body = buildRequest(items, context), parsed = parseResponse(answer(body), items, body);
  const check = buildVerification(parsed, context);
  assert.match(check.instructions, /Missing facts, conflicts/);
  assert.equal(check.max_output_tokens, 2048);
  assert.equal(JSON.parse(check.input[0].content).proposed.f1.answer, 'No');
  const [unsupported] = verifyResponse(envelope({ decisions: { f1: { supported: false } } }), parsed);
  assert.equal(unsupported.leave, true);
  assert.equal(unsupported.choice, null);
  assert.equal(unsupported.evidence, null);
  assert.equal(unsupported.autoOk, false);
  assert.throws(() => verifyResponse({ ...envelope({ decisions: { f1: { supported: true } } }), model: 'other-model' }, parsed), AssistError);
  assert.throws(() => verifyResponse(envelope({ decisions: { f1: { supported: 'true' } } }), parsed), AssistError);
});

test('suggestions wait for both calls; stale verification responses are discarded', async () => {
  let count = 0;
  const call = async ({ body }) => ++count === 1 ? answer(body) : envelope({ decisions: { f1: { supported: true } } });
  const result = await suggest(items, context, { apiKey: 'synthetic' }, { call });
  assert.equal(count, 2);
  assert.equal(result.suggestions[0].autoOk, true);
  assert.equal(result.tokensIn, 200);
  assert.equal(result.tokensOut, 60);
  assert.equal(result.modelCalls, 2);
  count = 0;
  await assert.rejects(suggest(items, context, { apiKey: 'synthetic' }, { call, isStale: () => count >= 2 }), /changed/);
});

test('twelve questions need two calls with complete facts and deduplicated verification evidence', async () => {
  const calls = [], fields = questions(12);
  const ctx = { ...context, carrier: 'amwins', record: { ...context.record,
    operations: { hazPlacard: false, radius: 0, notes: 'Contradicting details must remain visible.' },
    drivers: [{ name: 'active-person', licenseNumber: 'private-identifier' }, { name: 'inactive-person' }],
    priorInsurance: [{ expiration: '2020-01-01' }] } };
  const result = await suggest(fields, ctx, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    calls.push(body);
    return JSON.parse(body.input[0].content).fields ? groupAnswer(body) : groupCheck(body);
  } });
  assert.equal(result.modelCalls, 2);
  assert.equal(result.suggestions.length, 12);
  const first = JSON.parse(calls[0].input[0].content), second = JSON.parse(calls[1].input[0].content);
  assert.equal(first.intake, undefined, 'facts are not duplicated in the first request');
  assert.equal(Object.keys(first.fields).length, 12);
  const source = path => Object.values(first.sources).find(x => x.path === path);
  assert.equal(source('operations.hazPlacard').value, false);
  assert.equal(source('operations.radius').value, 0);
  assert.equal(source('operations.notes').value, ctx.record.operations.notes);
  assert.equal(source('drivers[0].name').value, 'active-person');
  assert.ok(source('computed.priorPolicyExpired'));
  assert.ok(Object.values(first.sources).some(x => x.basis === 'tni_rule'));
  assert.equal(Object.keys(second.sources).length, 1, 'a common fact is sent only once');
  assert.equal(second.intake.operations.notes, ctx.record.operations.notes, 'verification still sees uncited conflicts');
  assert.equal(Object.keys(second.proposed).length, 12);
  assert.deepEqual(second.proposed.f12.sourceIds, ['s1']);
  assert.equal(JSON.stringify(calls).includes('inactive-person'), false);
  assert.equal(JSON.stringify(calls).includes('private-identifier'), false);
  assert.ok(calls.every(body => JSON.stringify(body).length <= 48000));
});

test('more than twelve questions are grouped and abstention skips verification calls', async () => {
  const sizes = [];
  const result = await suggest(questions(13), context, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    const state = JSON.parse(body.input[0].content);
    assert.equal(state.proposed, undefined);
    sizes.push(Object.keys(state.fields).length);
    return groupAnswer(body, true);
  } });
  assert.deepEqual(sizes, [12, 1]);
  assert.equal(result.modelCalls, 2);
  assert.equal(result.suggestions.length, 13);
  assert.ok(result.suggestions.every(x => x.leave && !x.autoOk));
});

test('oversized groups split without truncating any source or visible option', async () => {
  const options = Array.from({ length: 10 }, (_, i) => `Option ${i}: ${'x'.repeat(1000)}`);
  const fields = questions(12).map(x => ({ ...x, options })), bodies = [];
  const result = await suggest(fields, context, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    bodies.push(body);
    const state = JSON.parse(body.input[0].content);
    assert.ok(JSON.stringify(body).length <= 48000);
    for (const field of Object.values(state.fields)) assert.deepEqual(Object.values(field.options), options);
    assert.equal(Object.values(state.sources).find(x => x.path === 'operations.hazPlacard').value, false);
    return groupAnswer(body, true);
  } });
  assert.ok(bodies.length > 1);
  assert.equal(result.suggestions.length, 12);
  assert.deepEqual(bodies.flatMap(body => Object.keys(JSON.parse(body.input[0].content).fields)), fields.map(x => x.id));
});

test('shared citation definitions retain exact choices and split at the API total enum limit', async () => {
  const options = Array.from({ length: 254 }, (_, i) => `Option ${i}`), fields = questions(12).map(x => ({ ...x, options }));
  const sizes = [];
  const result = await suggest(fields, context, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    const schema = body.text.format.schema, state = JSON.parse(body.input[0].content);
    const properties = schema.properties.decisions.properties;
    sizes.push(Object.keys(properties).length);
    let enumValues = schema.$defs.citations.items.enum.length;
    for (const [id, field] of Object.entries(properties)) {
      assert.deepEqual(field.properties.sourceIds, { $ref: '#/$defs/citations' });
      assert.deepEqual(Object.values(state.fields[id].options), options);
      enumValues += field.properties.option.enum.length;
    }
    assert.ok(enumValues <= 1000);
    return groupAnswer(body, true);
  } });
  assert.deepEqual(sizes, [3, 3, 3, 3]);
  assert.equal(result.suggestions.length, 12);
});

test('verification size is checked before paying for proposals', async () => {
  const ctx = { ...context, record: { operations: { hazPlacard: false, notes: 'x'.repeat(25000) } } };
  const body = buildRequest(items, ctx), parsed = parseResponse(answer(body), items, body);
  // The actual selected citation is small, but a legal four-citation answer could be too large.
  assert.ok(buildVerification(parsed, ctx));
  let calls = 0;
  await assert.rejects(suggest(items, ctx, { apiKey: 'synthetic' }, { call: async () => { calls++; } }), /too much context/);
  assert.equal(calls, 0);
});

test('groups also split for the largest legal verification while every request stays bounded', async () => {
  const notes = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`note${i}`, 'x'.repeat(1000)]));
  const ctx = { ...context, record: { operations: { hazPlacard: false, ...notes } } };
  const fields = questions(12).map(x => ({ ...x, label: `${x.label} ${'x'.repeat(1000)}` }));
  assert.ok(JSON.stringify(buildRequest(fields, ctx)).length <= 48000, 'the first request alone would fit all twelve');
  const sizes = [];
  const result = await suggest(fields, ctx, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    assert.ok(JSON.stringify(body).length <= 48000);
    const state = JSON.parse(body.input[0].content);
    if (state.proposed) return groupCheck(body);
    sizes.push(Object.keys(state.fields).length);
    const json = groupAnswer(body), decisions = JSON.parse(json.output[1].content[0].text).decisions;
    const ids = Object.keys(state.sources).filter(id => state.sources[id].path.startsWith('operations.note'));
    for (const [id, decision] of Object.entries(decisions)) {
      const offset = (Number(id.slice(1)) - 1) * 4;
      decision.sourceIds = Array.from({ length: 4 }, (_, i) => ids[(offset + i) % ids.length]);
    }
    return envelope({ decisions });
  } });
  assert.ok(sizes.length > 1);
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), 12);
  assert.equal(result.modelCalls, sizes.length * 2);
  assert.equal(result.suggestions.length, 12);
});

test('an invalid or individually oversized later question stops before all paid calls', async () => {
  for (const last of [{ ...items[0], id: 'f13', label: 'Order MVR?' },
    { ...items[0], id: 'f13', options: ['x'.repeat(48000)] }]) {
    let calls = 0;
    await assert.rejects(suggest([...questions(12), last], context, { apiKey: 'synthetic' }, {
      call: async () => { calls++; },
    }), AssistError);
    assert.equal(calls, 0);
  }
});

test('incomplete verification fails closed without spending again on a higher output cap', async () => {
  const bodies = [];
  await assert.rejects(suggest(items, context, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    bodies.push(body);
    return bodies.length === 1 ? answer(body) : { ...groupCheck(body), status: 'incomplete' };
  } }), /incomplete/);
  assert.deepEqual(bodies.map(x => x.max_output_tokens), [4096, 2048]);
});

test('usage counters ignore malformed values and reasoning is already included in output tokens', async () => {
  let calls = 0;
  const result = await suggest(items, context, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    const json = ++calls === 1 ? answer(body) : groupCheck(body);
    json.usage = calls === 1 ? { input_tokens: 100, output_tokens: 50,
      input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 20 } }
      : { input_tokens: '100', output_tokens: -5,
        input_tokens_details: { cached_tokens: Infinity, cache_write_tokens: NaN }, output_tokens_details: { reasoning_tokens: '20' } };
    return json;
  } });
  assert.equal(result.tokensIn, 100);
  assert.equal(result.tokensOut, 50);
  assert.equal(result.reasoningTokens, 20);
  assert.equal(result.cachedTokens, 80);
  assert.equal(result.cacheWriteTokens, 10);
  assert.equal(result.modelCalls, 2);
});

test('provider keys and opt-in automatic selection are isolated', () => {
  const legacy = { aiOn: true, aiAuto: true, aiKey: 'legacy', jevKey: 'typesafe', lunaKey: 'openai' };
  assert.equal(settingsFrom(legacy).provider, 'jev');
  const cfg = settingsFrom({ ...legacy, aiProvider: 'luna' });
  assert.equal(cfg.apiKey, 'openai');
  assert.equal(cfg.auto, false);
  assert.equal(cfg.model, DEFAULT_MODEL);
  assert.equal(settingsFrom({ ...legacy, aiProvider: 'luna', lunaAuto: true }).auto, true);
  assert.equal(settingsFrom({ aiProvider: 'jev', lunaAuto: true }).auto, false);
  assert.equal(settingsFrom({ ...legacy, aiProvider: 'jev', lunaAuto: false }).auto, true);
  assert.equal(settingsFrom().auto, false);
  assert.equal(settingsFrom({ aiProvider: 'luna', aiKey: 'legacy', jevKey: 'typesafe' }).apiKey, '');
  assert.equal(settingsFrom({ aiProvider: 'jev', lunaKey: 'openai' }).apiKey, '');
});

test('HTTP integration sends the key only to OpenAI and hides provider errors', async () => {
  let calls = 0;
  const body = buildRequest(items, context);
  const fetchImpl = async (url, init) => {
    assert.equal(url, API_URL);
    assert.equal(init.headers.authorization, 'Bearer synthetic');
    assert.equal(JSON.parse(init.body).store, false);
    calls++;
    if (calls === 1) return { status: 429, ok: false, headers: { get: () => '0' } };
    return { status: 200, ok: true, json: async () => answer(body) };
  };
  assert.equal((await callModel({ apiKey: 'synthetic', body, fetchImpl, sleep: async () => {} })).model, DEFAULT_MODEL);
  assert.equal(calls, 2);
  const refused = async () => ({ ok: false, status: 401, json: () => { throw new Error('echoed-private-input'); } });
  await assert.rejects(callModel({ apiKey: 'synthetic', body, fetchImpl: refused }), error =>
    /OpenAI API key was refused/.test(error.message) && !error.message.includes('private'));
  await assert.rejects(callModel({ body, fetchImpl }), /needs an OpenAI API key/);
});
