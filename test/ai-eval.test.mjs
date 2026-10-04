import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectItems } from '../src/ai/common.js';
import {
  DEFAULT_CASES_PATH,
  parseArgs,
  providerItems,
  providerContext,
  readCases,
  safeLiveResult,
  scoreResult,
} from '../scripts/ai-eval.mjs';

const cases = readCases(DEFAULT_CASES_PATH);

test('multiple supplied citations can match an expected evidence path without logging values', () => {
  const entry = cases[0];
  const result = safeLiveResult([entry], [{ suggestions: entry.expected.map(expected => ({ ...expected, intakePath: null,
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

test('evaluation inputs retain current choices and use bounded controls', () => {
  for (const entry of cases) {
    const items = providerItems(entry);
    assert.deepEqual(providerContext(entry), entry.context);
    assert.ok(items.every(item => ['radio', 'select', 'checkbox'].includes(item.controlKind)));
    assert.ok(items.every(item => item.current !== undefined));
  }
});

test('safety-boundary fields are blocked before Luna sees them', () => {
  const boundary = cases.find(entry => entry.id === 'safety-boundary');
  const collected = collectItems([{ unknown: providerItems(boundary) }]);
  assert.deepEqual(collected.items, []);
  assert.deepEqual(collected.blocked.map(item => item.key), ['order-mvr', 'declaration']);
});

test('saved safe results score choices, abstentions and evidence paths', () => {
  const result = safeLiveResult(cases, cases.map(entry => ({
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
  assert.equal(report.provider, 'luna');
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

test('usage metrics are sanitized, preserve zero and keep failed runs unavailable', () => {
  const [entry] = cases;
  const zero = safeLiveResult([entry], [{
    suggestions: [], tokensIn: 0, tokensOut: 0, modelCalls: 0, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
  }]);
  assert.deepEqual(zero.cases[0].usage, {
    tokensIn: 0, tokensOut: 0, modelCalls: 0, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
  });

  const malformed = safeLiveResult([entry], [{
    suggestions: [], tokensIn: '10', tokensOut: Infinity, modelCalls: -1,
    reasoningTokens: NaN, cachedTokens: {}, cacheWriteTokens: undefined,
  }]);
  assert.deepEqual(malformed.cases[0].usage, {
    tokensIn: null, tokensOut: null, modelCalls: null, reasoningTokens: null, cachedTokens: null, cacheWriteTokens: null,
  });

  const failed = safeLiveResult([entry], [{
    failed: true, tokensIn: 10, tokensOut: 2, modelCalls: 1, reasoningTokens: 3, cachedTokens: 4, cacheWriteTokens: 5,
  }]);
  assert.equal(failed.cases[0].status, 'error');
  assert.deepEqual(failed.cases[0].usage, {
    tokensIn: null, tokensOut: null, modelCalls: null, reasoningTokens: null, cachedTokens: null, cacheWriteTokens: null,
  });
});

test('reasoning tokens are reported separately from output tokens', () => {
  const result = safeLiveResult(cases.slice(0, 1), [{
    suggestions: cases[0].expected.map(expected => ({ ...expected })),
    tokensIn: 100, tokensOut: 12, modelCalls: 2, reasoningTokens: 8, cachedTokens: 30, cacheWriteTokens: 4,
  }]);
  const usage = scoreResult(result, cases.slice(0, 1)).aggregate.usage;
  assert.equal(usage.tokensOut, 12);
  assert.equal(usage.reasoningTokens, 8);
  assert.equal(usage.tokensOut + usage.reasoningTokens, 20);
});

test('missing, errored and unanswered runs are never counted as model abstentions', () => {
  const missing = scoreResult({ version: 1, provider: 'luna', cases: [] }, cases);
  assert.equal(missing.aggregate.serviceErrors, cases.length);
  assert.equal(missing.aggregate.unanswered, 0);
  assert.equal(missing.aggregate.correctChoices, 0);
  assert.equal(missing.aggregate.choiceAccuracy, null);
  assert.ok(missing.cases.every(entry => entry.status === 'missing'));

  const errored = safeLiveResult(cases, cases.map(() => ({ failed: true })));
  const errorReport = scoreResult(errored, cases);
  assert.equal(errorReport.aggregate.serviceErrors, cases.length);
  assert.equal(errorReport.aggregate.correctAbstentions, 0);
  assert.deepEqual(errorReport.aggregate.usage, {
    cases: 0, tokensIn: null, tokensOut: null, modelCalls: null, reasoningTokens: null, cachedTokens: null, cacheWriteTokens: null,
  });
  assert.ok(errorReport.cases.every(entry => entry.status === 'service-error'));

  const unanswered = safeLiveResult(cases, cases.map(() => ({ suggestions: [] })));
  const unansweredReport = scoreResult(unanswered, cases);
  assert.equal(unansweredReport.aggregate.serviceErrors, 0);
  assert.equal(unansweredReport.aggregate.unanswered, cases.reduce((sum, entry) => sum + entry.items.length, 0));
  assert.ok(unansweredReport.cases.every(entry => entry.status === 'unanswered'));
});

test('scoring flags false positives and evidence mismatches without exposing case data', () => {
  const result = safeLiveResult(cases, cases.map(entry => ({
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

test('live mode is explicit and Luna is the only evaluator', () => {
  assert.deepEqual(parseArgs(['--score', 'saved.json']), {
    live: false,
    scorePath: 'saved.json',
    casesPath: DEFAULT_CASES_PATH,
    outPath: null,
  });
  assert.deepEqual(parseArgs(['--live', '--out', 'safe.json']), {
    live: true,
    scorePath: null,
    casesPath: DEFAULT_CASES_PATH,
    outPath: 'safe.json',
  });
  assert.throws(() => parseArgs(['--provider', 'legacy']), /no longer supported/i);
  assert.throws(() => parseArgs(['--live', '--provider', 'legacy']), /no longer supported/i);
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
  const safe = safeLiveResult(cases.slice(0, 1), [{
    suggestions: [{ key: cases[0].items[0].key, choice: null, basis: 'none', explanation: 'raw intake prompt' }],
    timingMs: 4.4,
    tokensIn: 2,
    tokensOut: 1,
  }]);
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /raw intake prompt|OPENAI_API_KEY|secret/i);
  assert.deepEqual(Object.keys(safe.cases[0]).sort(), ['id', 'status', 'suggestions', 'timingMs', 'usage']);
  assert.deepEqual(Object.keys(safe.cases[0].suggestions[0]).sort(), ['basis', 'choice', 'key']);
});
