import test from 'node:test';
import assert from 'node:assert/strict';
import { collectItems, AssistError, LEAVE } from '../src/ai/common.js';
import { buildRequest, parseResponse, buildVerification, verifyResponse, suggest, callModel, responseData,
  DEFAULT_MODEL, noteLines, buildNotesReview, parseNotesReview, notesWarnings, reviewNotes } from '../src/ai/claude.js';
import { settingsFrom } from '../src/ai/providers.js';

const context = { carrier: 'geico', page: 'operations', active: { drivers: 0, vehicles: 0 },
  record: { operations: { hazPlacard: false }, drivers: [{ licenseNumber: 'private-identifier' }, { name: 'inactive-person' }], vehicles: [] } };
const items = collectItems([{ unknown: [{ key: 'haz', label: 'Hazardous materials requiring placards?', controlKind: 'select', options: ['Yes', 'No'], current: '' }] }]).items;
// A Messages API response: an (empty, by default) thinking block before the structured answer.
const envelope = data => ({ id: 'msg_synthetic', type: 'message', role: 'assistant', model: DEFAULT_MODEL,
  content: [{ type: 'thinking', thinking: '', signature: 'synthetic' }, { type: 'text', text: JSON.stringify(data) }],
  stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 30 } });
const claimsEnvelope = ({ lines, businessTime = { line: 'none', years: -1, since: -1 } }) => envelope({ lines, businessTime });
const answer = (body, overrides = {}) => {
  const state = JSON.parse(body.messages[0].content);
  const source = Object.keys(state.sources).find(k => state.sources[k].path === 'operations.hazPlacard');
  return envelope({ decisions: { f1: { option: 'o1', sourceIds: [source], explanation: 'The intake explicitly says No.', missingInformation: [], conflicts: [], ...overrides } } });
};
const questions = count => Array.from({ length: count }, (_, i) => ({ ...items[0], id: `f${i + 1}`, key: `haz${i + 1}` }));
const groupAnswer = (body, leave = false) => {
  const state = JSON.parse(body.messages[0].content);
  const source = Object.keys(state.sources).find(k => state.sources[k].path === 'operations.hazPlacard');
  return envelope({ decisions: Object.fromEntries(Object.keys(state.fields).map(id => [id, {
    option: leave ? LEAVE : 'o1', sourceIds: leave ? [] : [source], explanation: 'Explicit No.', missingInformation: [], conflicts: [],
  }])) });
};
const groupCheck = body => envelope({ decisions: Object.fromEntries(Object.keys(JSON.parse(body.messages[0].content).proposed)
  .map(id => [id, { supported: true }])) });

test('Claude requests a fixed model with structured output, low effort and no tools or sampling overrides', () => {
  const body = buildRequest(items, context), wire = JSON.stringify(body);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, 16000);
  assert.deepEqual(Object.keys(body.output_config).sort(), ['effort', 'format']);
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.thinking, undefined, 'adaptive thinking is the default and stays on');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.equal(wire.includes('private-identifier'), false);
  assert.equal(wire.includes('inactive-person'), false);
  assert.deepEqual(body.output_config.format.schema.properties.decisions.properties.f1.properties.option.enum, ['o0', 'o1', LEAVE]);
  assert.deepEqual(body.output_config.format.schema.properties.decisions.properties.f1.properties.sourceIds, { $ref: '#/$defs/citations' });
  assert.deepEqual(body.output_config.format.schema.$defs.citations.items.enum, [...Object.keys(JSON.parse(body.messages[0].content).sources), LEAVE]);
  // Claude's structured outputs reject maxItems; code checks the four-citation bound (shortList).
  assert.equal(wire.includes('maxItems'), false);
  assert.match(body.system, /Missing information is never evidence of No/);
  assert.match(body.system, /cite at most four/);
});

// Claude's structured outputs allow at most 16 union-typed fields (anyOf or type arrays) per request.
const unions = schema => JSON.stringify(schema).match(/"anyOf"|"type":\[/g)?.length ?? 0;
test('request schemas use no union types and every object is closed', () => {
  const body = buildRequest(questions(12), context);
  const notes = buildNotesReview({ coverage: {}, claims: { text: Array.from({ length: 25 }, (_, i) => `Line ${i} about the truck`).join('\n') } }).body;
  const first = buildRequest(items, context), checked = buildVerification(parseResponse(answer(first), items, first), context);
  for (const { output_config: { format: { schema } } } of [body, notes, checked]) {
    assert.equal(unions(schema), 0);
    const objects = [];
    (function walk(x) { if (x && typeof x === 'object') { if (x.type === 'object') objects.push(x); Object.values(x).forEach(walk); } })(schema);
    assert.ok(objects.length && objects.every(x => x.additionalProperties === false && x.required.length === Object.keys(x.properties).length));
  }
});

test('a decision citing more than four sources, or listing more than four notes, fails closed', () => {
  const body = buildRequest(items, context), state = JSON.parse(body.messages[0].content);
  const id = Object.keys(state.sources)[0];
  for (const override of [{ sourceIds: Array(5).fill(id) }, { missingInformation: ['a', 'b', 'c', 'd', 'e'] }, { conflicts: ['a', 'b', 'c', 'd', 'e'] }]) {
    assert.throws(() => parseResponse(answer(body, override), items, body), AssistError);
  }
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
  const state = JSON.parse(body.messages[0].content);
  const ids = Object.keys(state.sources).filter(id => state.sources[id].basis === 'intake');
  const [x] = parseResponse(answer(body, { sourceIds: ids }), items, body);
  assert.equal(x.intakePath, null);
  assert.equal(x.evidenceSources.length, 2);
  assert.deepEqual(x.evidenceSources.map(x => x.path), ['operations.hazPlacard', 'operations.notes']);
});

test('cut-off, refused, wrong-model and tool-call responses never yield an answer', () => {
  const body = buildRequest(items, context), good = answer(body), text = good.content[1];
  assert.equal(responseData({ ...good, content: [text] }).decisions.f1.option, 'o1', 'no thinking block is fine too');
  for (const json of [{ ...good, stop_reason: 'max_tokens' }, { ...good, stop_reason: 'tool_use' }, { ...good, stop_reason: 'pause_turn' },
    { ...good, model: 'other-model' }, { ...good, role: 'user' }, { ...good, type: 'error' }, null,
    { ...good, content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
    { ...good, content: [text, text] }, { ...good, content: [] },
    { ...good, content: [{ type: 'text', text: 'invalid' }] }]) {
    assert.throws(() => responseData(json), AssistError);
  }
  // A refusal is HTTP 200 with stop_reason refusal; its content (which may echo input) is never shown.
  assert.throws(() => responseData({ ...good, stop_reason: 'refusal', content: [{ type: 'text', text: 'private-input' }] }),
    error => /declined/.test(error.message) && !error.message.includes('private'));
  assert.throws(() => responseData({ ...good, stop_reason: 'max_tokens' }), /cut off/);
});

test('restricted fields cannot be submitted directly to Claude', () => {
  for (const label of ['Driver exclusions?', 'Order MVR?', 'Signature authorization']) {
    assert.throws(() => buildRequest([{ ...items[0], label }], context), AssistError);
  }
});

test('second evidence check rejects unsupported choices and mismatched schemas', () => {
  const body = buildRequest(items, context), parsed = parseResponse(answer(body), items, body);
  const check = buildVerification(parsed, context);
  assert.match(check.system, /Missing facts, conflicts/);
  assert.equal(check.max_tokens, 16000);
  assert.equal(check.output_config.effort, 'low');
  assert.equal(JSON.parse(check.messages[0].content).proposed.f1.answer, 'No');
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
    applicant: { name: 'Quenby Haulage LLC' },
    operations: { hazPlacard: false, radius: 0, notes: 'Contradicting details must remain visible. Zorvald Quenby drives.' },
    garaging: { street: '12 Synthetic Way', city: 'Sampleton', state: 'TX', zip: '75001' },
    drivers: [{ first: 'Zorvald', last: 'Quenby', dob: '02/02/1982', licenseState: 'TX', licenseNumber: 'private-identifier' }, { name: 'inactive-person' }],
    priorInsurance: [{ carrier: 'Synthetic Mutual', expiration: '2020-01-01' }] } };
  const result = await suggest(fields, ctx, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    calls.push(body);
    return JSON.parse(body.messages[0].content).fields ? groupAnswer(body) : groupCheck(body);
  } });
  assert.equal(result.modelCalls, 2);
  assert.equal(result.suggestions.length, 12);
  const first = JSON.parse(calls[0].messages[0].content), second = JSON.parse(calls[1].messages[0].content);
  assert.equal(first.intake, undefined, 'facts are not duplicated in the first request');
  assert.equal(Object.keys(first.fields).length, 12);
  const source = path => Object.values(first.sources).find(x => x.path === path);
  assert.equal(source('operations.hazPlacard').value, false);
  assert.equal(source('operations.radius').value, 0);
  // Audit 2026-10-08: client terms are redacted in both calls; the rest of the fact stays.
  assert.equal(source('operations.notes').value, 'Contradicting details must remain visible. [client] [client] drives.');
  assert.deepEqual([source('drivers[0].first').value, source('drivers[0].dob').value, source('drivers[0].licenseState').value], ['[client]', '[client]', 'TX']);
  assert.deepEqual([source('garaging.zip').value, source('garaging.state').value], ['[client]', 'TX']);
  assert.equal(source('priorInsurance[0].carrier').value, 'Synthetic Mutual', 'the prior carrier is not a redaction term');
  assert.ok(source('computed.priorPolicyExpired'));
  assert.ok(Object.values(first.sources).some(x => x.basis === 'tni_rule'));
  assert.equal(Object.keys(second.sources).length, 1, 'a common fact is sent only once');
  assert.equal(second.intake.operations.notes, source('operations.notes').value, 'verification still sees uncited conflicts, redacted the same way');
  assert.equal(second.intake['drivers[0]'].first, '[client]');
  assert.equal(Object.keys(second.proposed).length, 12);
  assert.deepEqual(second.proposed.f12.sourceIds, ['s1']);
  for (const term of ['inactive-person', 'private-identifier', 'Zorvald', 'Quenby', '02/02/1982', 'Sampleton', '75001', '12 Synthetic Way']) {
    assert.equal(JSON.stringify(calls).includes(term), false, `${term} must not reach the model`);
  }
  assert.ok(calls.every(body => JSON.stringify(body).length <= 48000));
});

test('more than twelve questions are grouped and abstention skips verification calls', async () => {
  const sizes = [];
  const result = await suggest(questions(13), context, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    const state = JSON.parse(body.messages[0].content);
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
    const state = JSON.parse(body.messages[0].content);
    assert.ok(JSON.stringify(body).length <= 48000);
    for (const field of Object.values(state.fields)) assert.deepEqual(Object.values(field.options), options);
    assert.equal(Object.values(state.sources).find(x => x.path === 'operations.hazPlacard').value, false);
    return groupAnswer(body, true);
  } });
  assert.ok(bodies.length > 1);
  assert.equal(result.suggestions.length, 12);
  assert.deepEqual(bodies.flatMap(body => Object.keys(JSON.parse(body.messages[0].content).fields)), fields.map(x => x.id));
});

test('shared citation definitions retain exact choices and split at the API total enum limit', async () => {
  const options = Array.from({ length: 254 }, (_, i) => `Option ${i}`), fields = questions(12).map(x => ({ ...x, options }));
  const sizes = [];
  const result = await suggest(fields, context, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    const schema = body.output_config.format.schema, state = JSON.parse(body.messages[0].content);
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
    const state = JSON.parse(body.messages[0].content);
    if (state.proposed) return groupCheck(body);
    sizes.push(Object.keys(state.fields).length);
    const json = groupAnswer(body), decisions = JSON.parse(json.content[1].text).decisions;
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

test('a cut-off verification fails closed without spending again on a higher output cap', async () => {
  const bodies = [];
  await assert.rejects(suggest(items, context, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    bodies.push(body);
    return bodies.length === 1 ? answer(body) : { ...groupCheck(body), stop_reason: 'max_tokens' };
  } }), /cut off/);
  assert.deepEqual(bodies.map(x => x.max_tokens), [16000, 16000]);
});

test('usage counters add cached input back, ignore malformed values, and count thinking within output', async () => {
  let calls = 0;
  const result = await suggest(items, context, { apiKey: 'synthetic' }, { call: async ({ body }) => {
    const json = ++calls === 1 ? answer(body) : groupCheck(body);
    json.usage = calls === 1 ? { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 }
      : { input_tokens: '100', output_tokens: -5, cache_read_input_tokens: Infinity, cache_creation_input_tokens: NaN };
    return json;
  } });
  assert.equal(result.tokensIn, 100);
  assert.equal(result.tokensOut, 50);
  assert.equal(result.reasoningTokens, 0);
  assert.equal(result.cachedTokens, 80);
  assert.equal(result.cacheWriteTokens, 10);
  assert.equal(result.modelCalls, 2);
});

test('Claude settings ignore obsolete providers and use only Claude opt-in fields', () => {
  const legacy = { aiOn: true, aiAuto: true, aiKey: 'legacy', jevKey: 'typesafe', jevModel: 'jev-old', lunaKey: 'openai', lunaAuto: true, claudeKey: 'anthropic' };
  assert.deepEqual(settingsFrom(legacy), {
    provider: 'claude', on: true, auto: false, apiKey: 'anthropic', model: DEFAULT_MODEL,
  });
  assert.deepEqual(settingsFrom({ ...legacy, claudeAuto: true, aiProvider: 'jev' }), {
    provider: 'claude', on: true, auto: true, apiKey: 'anthropic', model: DEFAULT_MODEL,
  });
  assert.deepEqual(settingsFrom({ aiProvider: 'luna', lunaKey: 'openai', lunaAuto: true }), {
    provider: 'claude', on: false, auto: false, apiKey: '', model: DEFAULT_MODEL,
  }, 'an OpenAI key is never sent to Anthropic');
  assert.equal(settingsFrom({ claudeKey: 'anthropic', claudeAuto: 'true' }).auto, false);
});

// The SDK's own request, with a test fetch: Response objects, as the browser's fetch returns.
const reply = (status, json, headers = {}) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
test('HTTP integration sends the key only to Anthropic, retries what the SDK retries, and hides provider errors', async () => {
  const body = buildRequest(items, context), seen = [];
  const fetchImpl = async (url, init) => {
    const headers = new Headers(init.headers);
    seen.push({ url: String(url), key: headers.get('x-api-key'), version: headers.get('anthropic-version'),
      browser: headers.get('anthropic-dangerous-direct-browser-access'), auth: headers.get('authorization'), body: JSON.parse(init.body) });
    return seen.length === 1 ? reply(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after-ms': '1' })
      : reply(200, answer(body));
  };
  const message = await callModel({ apiKey: 'synthetic', body, fetchImpl });
  assert.equal(message.model, DEFAULT_MODEL);
  assert.equal(parseResponse(message, items, body)[0].choice, 'No');
  assert.equal(seen.length, 2, 'one retry after a 429');
  for (const x of seen) {
    assert.equal(x.url, 'https://api.anthropic.com/v1/messages');
    assert.deepEqual([x.key, x.version, x.browser, x.auth], ['synthetic', '2023-06-01', 'true', null]);
    assert.deepEqual(x.body, body);
  }
  // Error bodies can echo the request: only the status picks the message.
  const failing = (status) => async () => reply(status, { type: 'error', error: { type: 'x', message: 'echoed-private-input' } });
  for (const [status, text] of [[401, /Anthropic API key was refused/], [400, /could not review/], [404, /unavailable/], [402, /billing/]]) {
    await assert.rejects(callModel({ apiKey: 'synthetic', body, fetchImpl: failing(status) }),
      error => error instanceof AssistError && text.test(error.message) && !error.message.includes('private'), String(status));
  }
  let tries = 0;
  await assert.rejects(callModel({ apiKey: 'synthetic', body, fetchImpl: async () => { tries++; return reply(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, { 'retry-after-ms': '1' }); } }), /overloaded/);
  assert.equal(tries, 3, 'two retries, then the agent is told');
  await assert.rejects(callModel({ apiKey: 'synthetic', body, fetchImpl: async () => { throw new TypeError('network down'); } }), /Cannot reach Claude/);
  await assert.rejects(callModel({ apiKey: 'synthetic', body, timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))) }), /took too long/);
  await assert.rejects(callModel({ body, fetchImpl }), /needs an Anthropic API key/);
});

// Synthetic claims box. PR #17 moved from Jev to Luna (OpenAI), and 2026-10-09 to Claude: flags only, one call, nothing applied.
test('claims-box review: one strict call with two flags per line, redacted, flags only', async () => {
  const record = { coverage: { autoLiability: 'Yes', autoLiabLimit: '$750k CSL', cargo: true, ntl: null },
    claims: { text: 'No\nWants $1M liability instead. Leased on with Sample Carrier, needs coverage off dispatch\nFinanced\nFinanced\nno bobtail' } };
  assert.deepEqual(noteLines(record.claims.text), ['Wants $1M liability instead.', 'Leased on with Sample Carrier, needs coverage off dispatch', 'Financed', 'no bobtail'], 'sentences, no repeats, no bare yes/no');
  const review = buildNotesReview(record, { redact: (line) => line.replace('Sample Carrier', '[client]') });
  const { body } = review;
  assert.equal(body.model, DEFAULT_MODEL);
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.output_config.format.schema.required, ['lines', 'businessTime']);
  const state = JSON.parse(body.messages[0].content);
  assert.deepEqual(Object.keys(state.claimsBox), ['l0', 'l1', 'l2', 'l3']);
  assert.match(state.claimsBox.l1, /\[client\]/, 'names are replaced before the request');
  assert.doesNotMatch(body.messages[0].content, /Sample Carrier/);
  assert.deepEqual(state.formCoverage, { autoLiability: 'Yes', autoLiabLimit: '$750k CSL', cargo: true }, 'the form coverage, not the agent-set NTL');
  assert.deepEqual(body.output_config.format.schema.properties.lines.required, ['l0', 'l1', 'l2', 'l3']);
  assert.equal(buildNotesReview({ coverage: {}, claims: { text: 'No' } }), null, 'nothing to read');

  const flags = (values) => claimsEnvelope({ lines: Object.fromEntries(values.map(([ntl, coverageChange], i) => [`l${i}`, { ntl, coverageChange }])) });
  // coverageChange means a change other than NTL (NTL has its own flag).
  const json = flags([[false, true], [true, false], [false, false], [false, false]]);
  const results = parseNotesReview(json, review);
  assert.equal(review.quoted, 'no bobtail', 'the line the intake\'s own NTL item quotes');
  assert.deepEqual(notesWarnings(results, review).map((w) => [w.code, w.path, w.level]), [['ai.coverage-change', 'claims.text', 'check'], ['ai.ntl', 'coverage.ntl', 'check']],
    'NTL and other coverage changes are separate flags');
  assert.ok(notesWarnings(results, review)[1].msg.includes('needs coverage off dispatch'), 'the line is quoted');
  assert.ok(notesWarnings(parseNotesReview(flags([[false, false], [false, false], [false, false], [true, false]]), review), review).length === 0,
    'the line the intake already quotes for NTL is not repeated');
  // Codex on PR #22: only that line, not every NTL line ("does not want bobtail" quoted first).
  const two = buildNotesReview({ coverage: {}, claims: { text: 'No\nDoes not want bobtail\nNeeds NTL off dispatch' } });
  assert.equal(two.quoted, 'Does not want bobtail');
  assert.deepEqual(notesWarnings(parseNotesReview(flags([[false, false], [true, false]]), two), two).map((w) => [w.code, w.msg.includes('Needs NTL off dispatch')]),
    [['ai.ntl', true]], 'a second, positive NTL line is still flagged');
  // Codex on PR #22: another request in the quoted line itself is kept.
  const shared = buildNotesReview({ coverage: {}, claims: { text: 'No\nNeeds NTL. Also needs physical damage.' } });
  assert.deepEqual(shared.lines, ['Needs NTL.', 'Also needs physical damage.']);
  assert.deepEqual(notesWarnings(parseNotesReview(flags([[true, false], [false, true]]), shared), shared).map((w) => [w.code, w.msg.includes('physical damage')]),
    [['ai.coverage-change', true]], 'only the NTL sentence is the intake\'s');
  // Codex on PR #22: one fragment with NTL and another request keeps the other request.
  const mixed = buildNotesReview({ coverage: {}, claims: { text: 'No\nNeeds NTL and physical damage' } });
  assert.deepEqual(notesWarnings(parseNotesReview(flags([[true, true]]), mixed), mixed).map((w) => w.code), ['ai.coverage-change'],
    'the NTL is the intake\'s item; the physical damage request is still flagged');
  assert.match(JSON.parse(JSON.stringify(mixed.body)).system, /other than non-trucking liability \(that is the ntl question\)/);

  assert.throws(() => parseNotesReview(flags([[false, true]]), review), AssistError, 'a missing line fails the whole review');
  assert.throws(() => parseNotesReview(claimsEnvelope({ lines: { l0: { ntl: 'yes', coverageChange: false }, l1: { ntl: false, coverageChange: false }, l2: { ntl: false, coverageChange: false }, l3: { ntl: false, coverageChange: false } } }), review), AssistError);
  assert.throws(() => parseNotesReview({ ...json, model: 'other-model' }, review), AssistError, 'an unexpected model fails');

  let sent;
  const done = await reviewNotes(record, { apiKey: 'synthetic-key' }, { call: async ({ apiKey, body }) => { sent = { apiKey, body }; return json; } });
  assert.equal(sent.apiKey, 'synthetic-key');
  assert.deepEqual(done.warnings.map((w) => w.code), ['ai.coverage-change', 'ai.ntl']);
  assert.equal(done.lines, 4);
  assert.equal(done.modelCalls, 1);
  assert.equal(done.tokensIn, 100);
  const cached = await reviewNotes(record, { apiKey: 'k' }, { call: async () => ({ ...json, usage: { input_tokens: 0, output_tokens: 5,
    cache_read_input_tokens: 60, cache_creation_input_tokens: 40 } }) });
  assert.deepEqual([cached.tokensIn, cached.cachedTokens, cached.cacheWriteTokens, cached.reasoningTokens], [100, 60, 40, 0], 'the same usage counters as page reviews');
  const none = await reviewNotes({ coverage: {}, claims: { text: '' } }, { apiKey: 'k' }, { call: async () => { throw new Error('no call expected'); } });
  assert.equal(none.modelCalls, 0);
});

// Codex on PR #22: Progressive's NTL section is unvalidated: its questions never reach the model.
test('non-trucking liability questions stay with the agent', () => {
  const { items, blocked } = collectItems([{ unknown: [
    { key: 'ntl1', label: 'Does the customer operate under dispatch?', section: 'Non-Trucking Liability', controlKind: 'radio', options: ['Yes', 'No'] },
    { key: 'ntl2', label: 'Bobtail coverage limit', controlKind: 'select', options: ['$300k', '$500k'] },
    { key: 'other', label: 'Does the customer haul hazardous materials?', controlKind: 'radio', options: ['Yes', 'No'] },
  ] }]);
  assert.deepEqual(items.map((x) => x.key), ['other']);
  assert.deepEqual(blocked.map((x) => x.key), ['ntl1', 'ntl2']);
});

// Codex on PR #22: counts are lines, not cards; a long claims box says what wasn't read.
test('claims-box review counts flagged lines and says when the box was too long to read whole', async () => {
  const mixed = { coverage: {}, claims: { text: 'No\nNeeds bobtail and physical damage\nFinanced' } };
  const two = (body) => claimsEnvelope({ lines: { l0: { ntl: true, coverageChange: true }, l1: { ntl: false, coverageChange: false } } });
  const done = await reviewNotes(mixed, { apiKey: 'k' }, { call: async ({ body }) => two(body) });
  assert.deepEqual(done.warnings.map((w) => w.code), ['ai.coverage-change'], 'the intake quotes the bobtail line');
  assert.equal(done.flagged, 1);
  assert.equal(done.lines, 2);
  assert.ok(done.warnings.every((w) => !('line' in w)), 'no extra fields on the intake items');
  const long = { coverage: {}, claims: { text: Array.from({ length: 25 }, (_, i) => `Line number ${i + 1} about the truck`).join('\n') } };
  const all = await reviewNotes(long, { apiKey: 'k' }, { call: async ({ body }) => claimsEnvelope({ lines: Object.fromEntries(Object.keys(JSON.parse(body.messages[0].content).claimsBox).map((id) => [id, { ntl: false, coverageChange: false }])) }) });
  assert.equal(all.lines, 20);
  assert.deepEqual(all.warnings.map((w) => [w.code, w.level]), [['ai.claims-truncated', 'check']]);
  assert.match(all.warnings[0].msg, /first 20 lines only/);
});

// Codex on PR #22: a later "NTL" line isn't the quoted "Does not want NTL"; "GL" alone is read.
test('claims-box review: only the quoted line\'s own sentences are the intake\'s, and short coverage words are read', () => {
  const flags = (values) => claimsEnvelope({ lines: Object.fromEntries(values.map(([ntl, coverageChange], i) => [`l${i}`, { ntl, coverageChange }])) });
  const review = buildNotesReview({ coverage: {}, claims: { text: 'No\nDoes not want NTL\nNTL' } });
  assert.deepEqual(review.lines, ['Does not want NTL', 'NTL']);
  assert.deepEqual(review.quotedFragments, ['Does not want NTL']);
  assert.deepEqual(notesWarnings(parseNotesReview(flags([[false, false], [true, false]]), review), review).map((w) => [w.code, w.line]),
    [['ai.ntl', 'NTL']], 'the later positive line keeps its item');
  assert.deepEqual(buildNotesReview({ coverage: { gl: false }, claims: { text: 'No\nGL' } }).lines, ['GL']);
  assert.equal(buildNotesReview({ coverage: {}, claims: { text: 'No' } }), null, 'a bare No is still nothing to read');
});

// WA run 2026-10-09: year established blank, "in Biz for 3+ years" in the claims box. Claude copies
// the stated years (or start year) once for the box; code compares them with the intake's and tells the agent.
test('claims-box review: a stated time in business the intake lacks or contradicts is a check item', async () => {
  const today = new Date('2026-10-09');
  const record = (applicant) => ({ applicant, coverage: {}, claims: { text: '1 AF in 2024\nin Biz for 3+ years' } });
  const lines = { l0: { ntl: false, coverageChange: false }, l1: { ntl: false, coverageChange: false } };
  const answer = (businessTime) => claimsEnvelope({ lines, businessTime: { line: 'l1', years: -1, since: -1, ...businessTime } });
  const blank = buildNotesReview(record({ yearsInBusiness: null, yearsExperience: null }), { today });
  const schema = blank.body.output_config.format.schema;
  assert.deepEqual(schema.properties.lines.properties.l0.required, ['ntl', 'coverageChange']);
  assert.deepEqual(schema.properties.businessTime.required, ['line', 'years', 'since']);
  assert.deepEqual(schema.properties.businessTime.properties.line.enum, ['l0', 'l1', 'none']);
  assert.equal(schema.properties.businessTime.properties.years.type, 'integer', 'no nullable union: -1 is "not stated"');
  assert.match(blank.body.system, /do not calculate/);

  const items = notesWarnings(parseNotesReview(answer({ years: 3 }), blank), blank);
  assert.deepEqual(items.map((w) => [w.code, w.path, w.level]), [['ai.years-in-business', 'applicant.yearsInBusiness', 'check']]);
  assert.match(items[0].msg, /"in Biz for 3\+ years" \(3 years\).*blank on the intake.*New Venture/);
  // A start year: code counts the years.
  assert.match(notesWarnings(parseNotesReview(answer({ since: 2021 }), blank), blank)[0].msg, /\(5 years\)/);
  // The intake agrees: nothing to say; it disagrees: say both.
  const three = buildNotesReview(record({ yearsInBusiness: 3 }), { today });
  assert.deepEqual(notesWarnings(parseNotesReview(answer({ years: 3 }), three), three), []);
  const one = buildNotesReview(record({ yearsInBusiness: null, yearsExperience: 1 }), { today });
  assert.match(notesWarnings(parseNotesReview(answer({ years: 3 }), one), one)[0].msg, /but the intake gives 1/);
  // Nothing stated: no item, whether no line or no number is given.
  assert.deepEqual(notesWarnings(parseNotesReview(answer({}), blank), blank), []);
  assert.deepEqual(notesWarnings(parseNotesReview(claimsEnvelope({ lines }), blank), blank), []);
  // Out-of-range or malformed answers fail the review.
  for (const bad of [{ years: -2 }, { years: 2.5 }, { years: 101 }, { since: 2027 }, { since: 1900 }, { years: '3' }, { line: 'l9' }, { line: null }, { extra: 1 }]) {
    assert.throws(() => parseNotesReview(answer(bad), blank), AssistError, JSON.stringify(bad));
  }
  assert.throws(() => parseNotesReview(envelope({ lines }), blank), AssistError, 'businessTime is required');
  const done = await reviewNotes(record({ yearsInBusiness: null }), { apiKey: 'k' }, { today, call: async () => answer({ years: 3 }) });
  assert.deepEqual(done.warnings.map((w) => w.code), ['ai.years-in-business']);
  assert.equal(done.flagged, 1);
});
