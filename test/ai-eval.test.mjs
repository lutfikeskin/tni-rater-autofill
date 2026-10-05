import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectItems } from '../src/ai/assist.js';
import {
  DEFAULT_CASES_PATH,
  parseArgs,
  providerItems,
  providerContext,
  providersFor,
  readCases,
  safeLiveResult,
  safeProvidersResult,
  scoreResult,
  scoreSavedResult,
} from '../scripts/ai-eval.mjs';

const cases = readCases(DEFAULT_CASES_PATH);

test('multiple supplied citations can match an expected evidence path without logging values', () => {
  const entry = cases[0];
  const result = safeLiveResult('luna', [entry], [{ suggestions: entry.expected.map(expected => ({ ...expected, intakePath: null,
    evidenceSources: expected.intakePath ? [{ basis: 'intake', path: 'operations.notes', value: 'private-notes' },
      { basis: 'intake', path: expected.intakePath, value: false }] : [] })) }]);
  assert.equal(scoreResult(result, [entry]).aggregate.evidencePathMatches, 1);
  assert.equal(JSON.stringify(result).includes('private-notes'), false);
});

test('synthetic cases are bounded, sanitized and explicitly unreviewed', () => {
  assert.equal(cases.length, 5);
  assert.ok(cases.every(entry => entry.expertReviewed === false));
  assert.deepEqual(cases.map(entry => entry.id), [
    'missing-vs-explicit-no',
    'ambiguous-notes',
    'conflicting-evidence',
    'unsupported-coverage-default',
    'safety-boundary',
  ]);
  assert.ok(cases.some(entry => entry.expected.some(answer => answer.choice === null)));
  assert.ok(cases.some(entry => entry.expected.some(answer => answer.choice === 'No')));
  assert.ok(cases.some(entry => entry.items.some(item => item.controlKind === 'select')));
  assert.ok(cases.some(entry => entry.items.some(item => item.controlKind === 'checkbox')));
  assert.equal(cases[0].context.record.applicant.name, 'Synthetic Hauling LLC');
  assert.equal(cases[2].context.record.operations.hazPlacard, true);
  assert.equal(cases[2].context.record.claims.notes.includes('no placard'), true);
  const serialized = JSON.stringify(cases);
  assert.doesNotMatch(serialized, /555-|SYNTHETIC-VIN|api[_-]?key|password/i);
});

test('evaluation cases require exactly one expected answer per item', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-eval-cases-'));
  const tempFile = path.join(tempDir, 'cases.json');
  try {
    const entry = structuredClone(cases[0]);
    entry.expected = [entry.expected[0], entry.expected[0], entry.expected[1]];
    fs.writeFileSync(tempFile, JSON.stringify({ version: 1, cases: [entry] }));
    assert.throws(() => readCases(tempFile), /one expected answer for every item/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('both provider inputs are equivalent and retain current choices', () => {
  for (const entry of cases) {
    const jevItems = providerItems(entry);
    const lunaItems = providerItems(entry);
    assert.deepEqual(lunaItems, jevItems);
    assert.deepEqual(providerContext(entry), entry.context);
    assert.ok(jevItems.every(item => ['radio', 'select', 'checkbox'].includes(item.controlKind)));
    assert.ok(jevItems.every(item => item.current !== undefined));
  }
});

test('safety-boundary fields are blocked before either provider sees them', () => {
  const boundary = cases.find(entry => entry.id === 'safety-boundary');
  const collected = collectItems([{ unknown: providerItems(boundary) }]);
  assert.deepEqual(collected.items, []);
  assert.deepEqual(collected.blocked.map(item => item.key), ['order-mvr', 'declaration']);
});

test('saved safe results score choices, abstentions and evidence paths', () => {
  const result = safeLiveResult('jev', cases, cases.map(entry => ({
    suggestions: entry.expected.map(expected => ({ ...expected })),
    timingMs: 10,
    tokensIn: 20,
    tokensOut: 4,
    modelCalls: 2,
    reasoningTokens: 7,
    cachedTokens: 5,
    cacheWriteTokens: 3,
  })));
  const report = scoreResult(result, cases);
  assert.equal(report.provider, 'jev');
  assert.equal(report.aggregate.choiceAccuracy, 1);
  assert.equal(report.aggregate.abstentionCorrectness, 1);
  assert.equal(report.aggregate.falsePositiveSuggestions, 0);
  assert.equal(report.aggregate.evidencePathMatchRate, 1);
  assert.equal(report.aggregate.timingMs.cases, cases.length);
  assert.equal(report.aggregate.usage.tokensIn, cases.length * 20);
  assert.equal(report.aggregate.usage.tokensOut, cases.length * 4);
  assert.equal(report.aggregate.usage.modelCalls, cases.length * 2);
  assert.equal(report.aggregate.usage.reasoningTokens, cases.length * 7);
  assert.equal(report.aggregate.usage.cachedTokens, cases.length * 5);
  assert.equal(report.aggregate.usage.cacheWriteTokens, cases.length * 3);
  assert.equal(report.aggregate.expertReviewedCases, 0);
  assert.equal(report.aggregate.calibration, 'not measured');
  assert.ok(report.cases.every(entry => entry.status === 'pass'));
});

test('saved results reject duplicate case IDs before scoring', () => {
  const entries = cases.slice(0, 2);
  const result = safeLiveResult('luna', entries, entries.map(entry => ({
    suggestions: entry.expected.map(expected => ({ ...expected })),
  })));
  result.cases[1].id = result.cases[0].id;
  assert.throws(() => scoreResult(result, entries), /unique case IDs/i);
});

test('timing median averages the two middle values for even samples', () => {
  const entries = cases.slice(0, 2);
  const result = safeLiveResult('luna', entries, entries.map((entry, index) => ({
    suggestions: entry.expected.map(expected => ({ ...expected })),
    timingMs: index ? 10000 : 100,
  })));
  assert.equal(scoreResult(result, entries).aggregate.timingMs.median, 5050);
});

test('all-leave results do not count abstentions as choices', () => {
  const entry = structuredClone(cases[0]);
  entry.id = 'all-leave';
  entry.expected = entry.expected.map(({ key }) => ({ key, choice: null, basis: 'none' }));
  const result = safeLiveResult('luna', [entry], [{ suggestions: entry.expected.map(expected => ({ ...expected })) }]);
  const report = scoreResult(result, [entry]);
  assert.equal(report.aggregate.scoredChoices, 0);
  assert.equal(report.aggregate.correctChoices, 0);
  assert.equal(report.aggregate.choiceAccuracy, null);
  assert.equal(report.aggregate.expectedAbstentions, entry.expected.length);
  assert.equal(report.aggregate.correctAbstentions, entry.expected.length);
  assert.equal(report.cases[0].status, 'pass');
});

test('evidence basis must match the expected source, including written rules', () => {
  const expected = cases[0].expected.find(answer => answer.choice !== null);
  const item = cases[0].items.find(candidate => candidate.key === expected.key);
  const entry = { ...structuredClone(cases[0]), id: 'tni-rule-basis', items: [item], expected: [{
    key: expected.key, choice: expected.choice, basis: 'tni_rule',
  }] };
  const wrong = safeLiveResult('luna', [entry], [{ suggestions: [{
    key: expected.key, choice: expected.choice, basis: 'intake',
  }] }]);
  const wrongReport = scoreResult(wrong, [entry]);
  assert.equal(wrongReport.aggregate.correctChoices, 0);
  assert.equal(wrongReport.aggregate.choiceAccuracy, 0);
  assert.equal(wrongReport.cases[0].status, 'fail');

  const matching = safeLiveResult('luna', [entry], [{ suggestions: [{
    key: expected.key, choice: expected.choice, basis: 'tni_rule',
  }] }]);
  const matchingReport = scoreResult(matching, [entry]);
  assert.equal(matchingReport.aggregate.correctChoices, 1);
  assert.equal(matchingReport.aggregate.choiceAccuracy, 1);
  assert.equal(matchingReport.cases[0].status, 'pass');
});

test('usage metrics are sanitized, preserve zero and keep failed runs unavailable', () => {
  const [entry] = cases;
  const zero = safeLiveResult('luna', [entry], [{
    suggestions: [], tokensIn: 0, tokensOut: 0, modelCalls: 0, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
  }]);
  assert.deepEqual(zero.cases[0].usage, {
    tokensIn: 0, tokensOut: 0, modelCalls: 0, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
  });

  const malformed = safeLiveResult('luna', [entry], [{
    suggestions: [], tokensIn: '10', tokensOut: Infinity, modelCalls: -1,
    reasoningTokens: NaN, cachedTokens: {}, cacheWriteTokens: undefined,
  }]);
  assert.deepEqual(malformed.cases[0].usage, {
    tokensIn: null, tokensOut: null, modelCalls: null, reasoningTokens: null, cachedTokens: null, cacheWriteTokens: null,
  });

  const failed = safeLiveResult('jev', [entry], [{
    failed: true, tokensIn: 10, tokensOut: 2, modelCalls: 1, reasoningTokens: 3, cachedTokens: 4, cacheWriteTokens: 5,
  }]);
  assert.equal(failed.cases[0].status, 'error');
  assert.deepEqual(failed.cases[0].usage, {
    tokensIn: null, tokensOut: null, modelCalls: null, reasoningTokens: null, cachedTokens: null, cacheWriteTokens: null,
  });
});

test('reasoning tokens are reported separately from output tokens', () => {
  const result = safeLiveResult('luna', cases.slice(0, 1), [{
    suggestions: cases[0].expected.map(expected => ({ ...expected })),
    tokensIn: 100, tokensOut: 12, modelCalls: 2, reasoningTokens: 8, cachedTokens: 30, cacheWriteTokens: 4,
  }]);
  const usage = scoreResult(result, cases.slice(0, 1)).aggregate.usage;
  assert.equal(usage.tokensOut, 12);
  assert.equal(usage.reasoningTokens, 8);
  assert.equal(usage.tokensOut + usage.reasoningTokens, 20);
});

test('missing, errored and unanswered runs are never counted as model abstentions', () => {
  const missing = scoreResult({ version: 1, provider: 'jev', cases: [] }, cases);
  assert.equal(missing.aggregate.serviceErrors, cases.length);
  assert.equal(missing.aggregate.unanswered, 0);
  assert.equal(missing.aggregate.correctChoices, 0);
  assert.equal(missing.aggregate.choiceAccuracy, null);
  assert.ok(missing.cases.every(entry => entry.status === 'missing'));

  const errored = safeLiveResult('jev', cases, cases.map(() => ({ failed: true })));
  const errorReport = scoreResult(errored, cases);
  assert.equal(errorReport.aggregate.serviceErrors, cases.length);
  assert.equal(errorReport.aggregate.correctAbstentions, 0);
  assert.deepEqual(errorReport.aggregate.usage, {
    cases: 0, tokensIn: null, tokensOut: null, modelCalls: null, reasoningTokens: null, cachedTokens: null, cacheWriteTokens: null,
  });
  assert.ok(errorReport.cases.every(entry => entry.status === 'service-error'));

  const unanswered = safeLiveResult('jev', cases, cases.map(() => ({ suggestions: [] })));
  const unansweredReport = scoreResult(unanswered, cases);
  assert.equal(unansweredReport.aggregate.serviceErrors, 0);
  assert.equal(unansweredReport.aggregate.unanswered, cases.reduce((sum, entry) => sum + entry.items.length, 0));
  assert.ok(unansweredReport.cases.every(entry => entry.status === 'unanswered'));
});

test('scoring flags false positives and evidence mismatches without exposing case data', () => {
  const result = safeLiveResult('luna', cases, cases.map(entry => ({
    suggestions: entry.expected.map(expected => ({ ...expected, choice: expected.choice === null ? 'Yes' : expected.choice, intakePath: 'invented.path' })),
  })));
  const report = scoreResult(result, cases);
  assert.equal(report.provider, 'luna');
  assert.ok(report.aggregate.falsePositiveSuggestions > 0);
  assert.equal(report.aggregate.abstentionCorrectness, 0);
  assert.equal(report.aggregate.evidencePathMatchRate, 0);
  assert.equal(report.cases.filter(entry => entry.status === 'fail').length, cases.length);
  assert.equal(Object.hasOwn(report, 'raw'), false);
});

test('live mode is explicit and provider selection is bounded', () => {
  assert.deepEqual(providersFor('jev'), ['jev']);
  assert.deepEqual(providersFor('luna'), ['luna']);
  assert.deepEqual(providersFor('both'), ['jev', 'luna']);
  assert.deepEqual(parseArgs(['--score', 'saved.json']), {
    live: false,
    scorePath: 'saved.json',
    casesPath: DEFAULT_CASES_PATH,
    provider: null,
    outPath: null,
  });
  assert.deepEqual(parseArgs(['--live', '--provider', 'both', '--out', 'safe.json']), {
    live: true,
    scorePath: null,
    casesPath: DEFAULT_CASES_PATH,
    provider: 'both',
    outPath: 'safe.json',
  });
  assert.throws(() => parseArgs(['--provider', 'jev']), /exactly one mode/i);
  assert.throws(() => parseArgs(['--live']), /requires --provider/i);
  assert.throws(() => parseArgs(['--live', '--provider', 'openai']), /requires --provider/i);
});

test('both-provider safe results round-trip through offline scoring', () => {
  const make = provider => safeLiveResult(provider, cases, cases.map(entry => ({
    suggestions: entry.expected.map(expected => ({ ...expected })),
    timingMs: 8,
    tokensIn: 3,
    tokensOut: 2,
  })));
  const wrapped = safeProvidersResult([make('jev'), make('luna')]);
  const reports = scoreSavedResult(wrapped, cases);
  assert.deepEqual(reports.map(report => report.provider), ['jev', 'luna']);
  assert.ok(reports.every(report => report.aggregate.choiceAccuracy === 1));
  assert.deepEqual(Object.keys(wrapped.providers).sort(), ['jev', 'luna']);
  assert.equal(wrapped.providers.jev.cases[0].status, 'ok');
});

test('future expert-reviewed custom case sets are accepted', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-eval-cases-'));
  const tempFile = path.join(tempDir, 'cases.json');
  try {
    const custom = { version: 1, cases: [{ ...structuredClone(cases[0]), expertReviewed: true }] };
    fs.writeFileSync(tempFile, JSON.stringify(custom));
    assert.equal(readCases(tempFile)[0].expertReviewed, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('safe result output omits provider explanations, prompts and credentials', () => {
  const safe = safeLiveResult('jev', cases.slice(0, 1), [{
    suggestions: [{ key: cases[0].items[0].key, choice: null, basis: 'none', explanation: 'raw intake prompt' }],
    timingMs: 4.4,
    tokensIn: 2,
    tokensOut: 1,
  }]);
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /raw intake prompt|JEV_API_KEY|OPENAI_API_KEY|secret/i);
  assert.deepEqual(Object.keys(safe.cases[0]).sort(), ['id', 'status', 'suggestions', 'timingMs', 'usage']);
  assert.deepEqual(Object.keys(safe.cases[0].suggestions[0]).sort(), ['basis', 'choice', 'key']);
});
