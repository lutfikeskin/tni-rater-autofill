import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_POLICY,
  API_URL,
  AssistError,
  DEFAULT_MODEL,
  LEAVE,
  assistContextKey,
  buildRequest,
  buildVerification,
  callModel,
  collectItems,
  neverReason,
  parseResponse,
  settingsFrom,
  suggest,
  verifyResponse,
} from '../src/ai/assist.js';

// All records in this file are synthetic. They deliberately contain two rows so that a
// request can prove that Jev receives only the active driver and vehicle.
const record = {
  applicant: {
    name: 'Synthetic Hauler LLC',
    dot: 'DOT-SYNTHETIC',
    mc: 'MC-SYNTHETIC',
    phone: '555-0100',
    fein: '99-0000000',
  },
  operations: { businessClass: 'Expediter', radius: 600 },
  garaging: { state: 'TX', zip: '75001' },
  coverage: { reeferBreakdown: false },
  drivers: [
    { first: 'First', last: 'Driver', dob: '01/01/1980', phone: '555-0101' },
    { first: 'Active', last: 'Driver', dob: '02/02/1982', phone: '555-0102' },
  ],
  vehicles: [
    { type: 'Cargo Van', vin: 'SYNTHETIC-VIN-0', value: 20000 },
    { type: 'Truck Tractor', vin: 'SYNTHETIC-VIN-1', value: 40000 },
  ],
  trailers: [{ type: 'Dry Van' }],
  extraPrivateValue: 'must not be sent',
};

const context = {
  record,
  carrier: 'progressive',
  page: 'BusinessOwnerInfo',
  active: { drivers: 1, vehicles: 1, trailers: 0 },
  onPage: Array.from({ length: 45 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}`, controlKind: 'radio' })),
};

function item(key, label = 'Synthetic question', options = ['Yes', 'No'], extra = {}) {
  return { key, q: key, label, controlKind: 'radio', options, ...extra };
}

function responseFor(body, items, {
  choice = 'o0',
  source = Object.keys(body.state.sources).find((key) => key !== LEAVE),
  probability = 0.99,
  sourceProbability = 0.99,
  model = body.model,
} = {}) {
  const answer = {};
  for (const x of items) {
    const keys = Object.keys(body.questions[x.id].criteria);
    const sourceKeys = Object.keys(body.questions[`${x.id}_source`].criteria);
    answer[x.id] = choiceAnswer(choice, keys, probability);
    answer[`${x.id}_source`] = choiceAnswer(source, sourceKeys, sourceProbability);
  }
  return { model, answers: answer, usage: { input_tokens: 11, output_tokens: 7 } };
}

function choiceAnswer(choice, keys, selected = 0.99) {
  const rest = (1 - selected) / (keys.length - 1);
  const probabilities = Object.fromEntries(keys.map((key) => [key, key === choice ? selected : rest]));
  const confidence = (selected - 1 / keys.length) / (1 - 1 / keys.length);
  return { type: 'choice', choice, probabilities, confidence };
}

test('context keys include the intake and active rows, and settings use only Jev keys', () => {
  const key = assistContextKey(record, context.active);
  assert.equal(key, assistContextKey(structuredClone(record), { ...context.active }));
  assert.notEqual(key, assistContextKey(record, { ...context.active, vehicles: 0 }));
  assert.notEqual(key, assistContextKey({ ...record, coverage: { reeferBreakdown: true } }, context.active));

  assert.deepEqual(settingsFrom({
    aiOn: true,
    aiAuto: true,
    jevKey: 'jev-synthetic-key',
    jevModel: 'jev-test-model',
    aiKey: 'legacy-openai-key',
    aiModel: 'gpt-6-luna',
    openaiKey: 'another-legacy-key',
  }), { on: true, auto: true, apiKey: 'jev-synthetic-key', model: 'jev-test-model' });
  assert.equal(settingsFrom({ aiOn: true, aiKey: 'legacy-openai-key' }).apiKey, '');
  assert.equal(settingsFrom({ aiOn: true, aiKey: 'legacy-openai-key' }).model, DEFAULT_MODEL);
});

test('collectItems sends only bounded choices and blocks unsafe or unsupported fields', () => {
  const frames = [{
    failed: [
      item('choice', 'Hauls goods for others?'),
      item('duplicate', 'Duplicated question'),
    ],
    unknown: [
      item('duplicate', 'Duplicated question'),
      { key: 'typed', label: 'VIN', controlKind: 'text', options: [] },
      { key: 'mvr', label: 'Order the MVR report?', controlKind: 'radio', options: ['Yes', 'No'] },
      { key: 'lookup', label: 'Does this DOT belong to the business?', controlKind: 'radio', options: ['Yes', 'No'], reviewOnly: true },
      { key: 'empty', label: 'Business type', controlKind: 'select', options: [] },
      { key: 'too-many', label: 'Synthetic long list', controlKind: 'select', options: Array.from({ length: 255 }, (_, i) => `Option ${i}`) },
    ],
    noData: [{ key: 'check', label: 'Synthetic checkbox', controlKind: 'checkbox' }],
  }];

  const { items, blocked } = collectItems(frames);
  assert.deepEqual(items.map((x) => x.key), ['choice', 'duplicate', 'check']);
  assert.deepEqual(items.find((x) => x.key === 'check').options, ['checked', 'unchecked']);
  assert.deepEqual(blocked.map((x) => x.key).sort(), ['empty', 'lookup', 'mvr', 'too-many', 'typed']);
  assert.match(blocked.find((x) => x.key === 'lookup').why, /review/i);
  assert.match(blocked.find((x) => x.key === 'typed').why, /identifier/i);
  assert.match(blocked.find((x) => x.key === 'too-many').why, /choices/i);
  assert.ok(neverReason({ section: 'Reports', label: 'Order CLUE report?' }));
  assert.equal(neverReason({ section: 'Business', label: 'Has a USDOT number?', controlKind: 'radio' }), null);
});

test('request shape scopes active rows, strips identifiers, and includes only carrier rules', () => {
  const items = [item('q1', 'Does the carrier answer this synthetic field?', ['Yes', 'No'])]
    .map((x, i) => ({ ...x, id: `f${i + 1}` }));
  const body = buildRequest(items, context, { model: 'jev-synthetic-model' });

  assert.equal(body.model, 'jev-synthetic-model');
  assert.equal(body.state.carrier, 'progressive');
  assert.equal(body.state.page, 'BusinessOwnerInfo');
  assert.equal(body.state.active.vehicles, 1);
  assert.equal(body.state.onPage.length, 40);
  assert.ok(body.state.intake['drivers[1]']);
  assert.ok(body.state.intake['vehicles[1]']);
  assert.equal(body.state.intake['drivers[0]'], undefined);
  assert.equal(body.state.intake['vehicles[0]'], undefined);
  assert.equal(body.state.intake.applicant.hasDOT, true);
  assert.equal(body.state.intake.applicant.hasMC, true);
  assert.equal(body.state.intake.applicant.phone, undefined);
  assert.equal(body.state.intake.applicant.fein, undefined);
  assert.equal(body.state.intake['vehicles[1]'].vin, undefined);
  assert.equal(body.state.intake.extraPrivateValue, undefined);

  assert.deepEqual(Object.keys(body.questions).sort(), ['f1', 'f1_source']);
  assert.deepEqual(Object.keys(body.questions.f1.criteria), ['o0', 'o1', LEAVE]);
  assert.equal(body.questions.f1.type, 'choice');
  assert.equal(body.questions.f1_source.type, 'choice');
  assert.equal(body.questions.f1_source.criteria[LEAVE], 'No sufficient evidence; requires agent review.');
  const progressiveRules = Object.values(body.state.sources).filter((x) => x.basis === 'tni_rule').map((x) => x.rule);
  assert.ok(progressiveRules.some((rule) => /vehicle tile/i.test(rule)));
  assert.ok(progressiveRules.every((rule) => !/AmWINS lists|Commercial Lines dashboard/i.test(rule)));

  const amwins = buildRequest(items, { ...context, carrier: 'amwins' });
  const amwinsRules = Object.values(amwins.state.sources).filter((x) => x.basis === 'tni_rule').map((x) => x.rule);
  assert.ok(amwinsRules.some((rule) => /Commercial Lines dashboard/i.test(rule)));
  assert.ok(amwinsRules.every((rule) => !/vehicle tile/i.test(rule)));
});

test('response validation rejects invented choices, malformed probabilities, and unsupported evidence', () => {
  const items = [item('q1', 'Synthetic bounded field')].map((x, i) => ({ ...x, id: `f${i + 1}` }));
  const body = buildRequest(items, context);
  const valid = responseFor(body, items);
  const [good] = parseResponse(valid, items, body);
  assert.equal(good.choice, 'Yes');
  assert.equal(good.leave, false);
  assert.equal(good.basis, 'intake');
  assert.match(good.intakePath, /^applicant\.|^operations\.|^garaging\.|^coverage\.|^drivers\[1\]|^vehicles\[1\]/);
  assert.equal(good.policy, 'jev-evidence-v1');

  const invented = structuredClone(valid);
  invented.answers.f1.choice = 'o99';
  const [inventedResult] = parseResponse(invented, items, body);
  assert.equal(inventedResult.leave, true);
  assert.equal(inventedResult.choice, null);

  const malformed = structuredClone(valid);
  malformed.answers.f1.probabilities.o0 = 0.7;
  const [malformedResult] = parseResponse(malformed, items, body);
  assert.equal(malformedResult.leave, true);

  const fabricatedEvidence = structuredClone(valid);
  fabricatedEvidence.answers.f1_source.choice = LEAVE;
  const [noEvidence] = parseResponse(fabricatedEvidence, items, body);
  assert.equal(noEvidence.leave, true);
  assert.equal(noEvidence.evidence, null);

  const partialDistribution = structuredClone(valid);
  delete partialDistribution.answers.f1.probabilities[LEAVE];
  const [partial] = parseResponse(partialDistribution, items, body);
  assert.equal(partial.leave, true);
});

test('verification uses Noul support and auto-selection remains fail-closed', () => {
  const items = [item('q1', 'Synthetic bounded field')].map((x, i) => ({ ...x, id: `f${i + 1}` }));
  const body = buildRequest(items, context);
  const [suggestion] = parseResponse(responseFor(body, items), items, body);
  const verification = buildVerification([suggestion], context);
  assert.equal(verification.model, DEFAULT_MODEL);
  assert.deepEqual(Object.keys(verification.questions), ['f1']);
  assert.equal(verification.questions.f1.type, 'noul');
  assert.match(verification.questions.f1.instructions.task, /support/i);
  assert.deepEqual(verification.state.intake['vehicles[1]'], body.state.intake['vehicles[1]']);

  const verified = verifyResponse({ model: DEFAULT_MODEL, answers: { f1: { type: 'noul', noul: 0.995 } } }, [suggestion]);
  assert.equal(verified[0].support, 0.995);
  assert.equal(verified[0].autoOk, true);
  assert.match(verified[0].tip, /Passed the automatic-selection checks/);

  const numericReview = verifyResponse({ model: DEFAULT_MODEL, answers: { f1: { type: 'noul', noul: 0.995 } } },
    [{ ...suggestion, label: 'Annual mileage' }]);
  assert.equal(numericReview[0].autoOk, false);
  assert.match(numericReview[0].tip, /Review this suggestion/);

  const belowProbability = verifyResponse({ model: DEFAULT_MODEL, answers: { f1: { type: 'noul', noul: 0.995 } } },
    [{ ...suggestion, probability: AUTO_POLICY.probability - 0.001 }]);
  assert.equal(belowProbability[0].autoOk, false);

  const unsupported = verifyResponse({ model: DEFAULT_MODEL, answers: { f1: { type: 'noul', noul: 0.79 } } }, [suggestion]);
  assert.equal(unsupported[0].leave, true);
  assert.equal(unsupported[0].choice, null);
  assert.equal(unsupported[0].autoOk, false);
  assert.match(unsupported[0].tip, /could not verify/i);

  const wrongModel = verifyResponse({ model: 'other-jev', answers: { f1: { type: 'noul', noul: 0.995 } } }, [suggestion]);
  assert.equal(wrongModel[0].leave, true);
});

test('callModel uses the TypeSafe endpoint, retries transient responses, and sanitizes failures', async () => {
  const calls = [];
  const delays = [];
  let attempt = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    attempt += 1;
    if (attempt === 1) return { ok: false, status: 429, headers: { get: () => '0.01' } };
    return { ok: true, status: 200, json: async () => ({ model: DEFAULT_MODEL, answers: {} }) };
  };
  const result = await callModel({ apiKey: 'jev-synthetic-key', body: { model: DEFAULT_MODEL }, fetchImpl,
    sleep: async (ms) => delays.push(ms) });
  assert.equal(result.model, DEFAULT_MODEL);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, API_URL);
  assert.equal(calls[0].init.headers.authorization, 'Bearer jev-synthetic-key');
  assert.deepEqual(delays, [250]);
  assert.equal(JSON.parse(calls[0].init.body).model, DEFAULT_MODEL);

  await assert.rejects(callModel({ apiKey: '', body: {}, fetchImpl }), /No TypeSafe API key/);
  const failing = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'jev-synthetic-key leaked' } }) });
  await assert.rejects(callModel({ apiKey: 'jev-synthetic-key', body: {}, fetchImpl: failing }), (error) => {
    assert.ok(error instanceof AssistError);
    assert.match(error.message, /key was refused/);
    assert.doesNotMatch(error.message, /jev-synthetic-key leaked/);
    return true;
  });
  await assert.rejects(callModel({ apiKey: 'jev-synthetic-key', body: {}, fetchImpl: async () => {
    throw new TypeError('provider echoed jev-synthetic-key');
  } }), (error) => {
    assert.match(error.message, /Cannot reach Jev/);
    assert.doesNotMatch(error.message, /jev-synthetic-key/);
    return true;
  });
  await assert.rejects(callModel({ apiKey: 'jev-synthetic-key', body: {}, timeoutMs: 5,
    fetchImpl: (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) }), /took too long/);
});

test('suggest performs choice then verification stages and drops stale results', async () => {
  const items = [item('q1', 'First synthetic bounded field'), item('q2', 'Second synthetic bounded field')]
    .map((x, i) => ({ ...x, id: `f${i + 1}` }));
  const calls = [];
  const call = async ({ body }) => {
    calls.push(body);
    if (Object.values(body.questions).some((q) => q.type === 'noul')) {
      return { model: DEFAULT_MODEL, answers: Object.fromEntries(items.map((x) => [x.id, { type: 'noul', noul: 0.995 }])),
        usage: { input_tokens: 11, output_tokens: 7 } };
    }
    return responseFor(body, items);
  };
  const result = await suggest(items, context, { apiKey: 'jev-synthetic-key', model: DEFAULT_MODEL }, { call });
  assert.equal(calls.length, 2);
  assert.ok(Object.values(calls[0].questions).every((q) => q.type === 'choice'));
  assert.ok(Object.values(calls[1].questions).every((q) => q.type === 'noul'));
  assert.equal(result.suggestions.length, 2);
  assert.ok(result.suggestions.every((x) => x.autoOk));
  assert.equal(result.tokensIn, 22);
  assert.equal(result.tokensOut, 14);

  let stale = false;
  let staleCalls = 0;
  await assert.rejects(suggest(items, context, { apiKey: 'jev-synthetic-key', model: DEFAULT_MODEL }, {
    call: async (args) => {
      staleCalls += 1;
      const value = responseFor(args.body, items);
      stale = true;
      return value;
    },
    isStale: () => stale,
  }), /page or intake changed/i);
  assert.equal(staleCalls, 1, 'verification is never started for a stale first-stage result');
});


test('filled-page context cannot bypass identifier filtering, and text is rejected at the request boundary', () => {
  const items = [{ ...item('x'), id: 'f1' }];
  const body = buildRequest(items, { ...context, onPage: [
    { question: 'VIN', answer: 'DO-NOT-SEND-VIN', controlKind: 'text' },
    { question: 'USDOT number', answer: 'DO-NOT-SEND-DOT', controlKind: 'select' },
    { question: 'License number', answer: 'DO-NOT-SEND-LICENSE', controlKind: 'text' },
    { question: 'Hauls for others?', answer: 'Yes', controlKind: 'radio' },
  ] });
  assert.equal(body.state.onPage.length, 1);
  assert.doesNotMatch(JSON.stringify(body), /DO-NOT-SEND/);
  assert.throws(() => buildRequest([{ ...items[0], controlKind: 'text' }], context), /visible choices/);
});
