#!/usr/bin/env node
// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
// Offline scoring and opt-in live evaluation for Luna: page reviews (cases.json), the claims-box
// review (notes-cases.json) and the driver-name check (names-cases.json).
//
// Offline scoring:
//   node scripts/ai-eval.mjs --score result.json
// Live evaluation (never run implicitly):
//   OPENAI_API_KEY=... node scripts/ai-eval.mjs --live
//   OPENAI_API_KEY=... node scripts/ai-eval.mjs --live --out result.json --responses responses.json
// Replay (offline, no key): today's code on the model answers a live run saved with --responses.
// A request today's code builds differently (a prompt, rule or code change) has no saved answer:
// that case is a service error, to run live again.
//   node scripts/ai-eval.mjs --replay responses.json

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { collectItems, pseudonymizeChoices } from '../src/ai/common.js';
import { DEFAULT_MODEL, suggest as suggestLuna, callModel, buildNotesReview, parseNotesReview, buildNameReview, parseNameReview, NAME_GUESSES, noteLines } from '../src/ai/luna.js';
import { intakeNotes } from '../src/normalize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CASES_PATH = path.join(ROOT, 'test/ai-eval/cases.json');
export const DEFAULT_NOTES_PATH = path.join(ROOT, 'test/ai-eval/notes-cases.json');
export const DEFAULT_NAMES_PATH = path.join(ROOT, 'test/ai-eval/names-cases.json');

const clone = value => structuredClone(value);
const tidy = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const isChoice = value => value === null || (typeof value === 'string' && value.trim() !== '');
const USAGE_METRICS = Object.freeze([
  'tokensIn', 'tokensOut', 'modelCalls', 'reasoningTokens', 'cachedTokens', 'cacheWriteTokens',
]);

function safeMetric(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function fail(message) {
  throw new Error(message);
}

export function readCases(file = DEFAULT_CASES_PATH) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    fail('AI evaluation cases must be version 1 with at least one case.');
  }
  const seen = new Set();
  for (const entry of parsed.cases) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) fail('AI evaluation case IDs must be unique.');
    seen.add(entry.id);
    if (!entry.context || typeof entry.context !== 'object' || !Array.isArray(entry.items) || !Array.isArray(entry.expected)) {
      fail(`AI evaluation case ${entry.id} is missing context, items or expected answers.`);
    }
    if (typeof entry.expertReviewed !== 'boolean') fail(`AI evaluation case ${entry.id} must set expertReviewed to a boolean.`);
    const itemKeys = new Set();
    for (const item of entry.items) {
      if (!item || typeof item.key !== 'string' || itemKeys.has(item.key)) fail(`AI evaluation case ${entry.id} has invalid item keys.`);
      itemKeys.add(item.key);
      if (!['radio', 'select', 'checkbox'].includes(item.controlKind)) fail(`AI evaluation case ${entry.id} has an unsupported control kind.`);
      if (!Array.isArray(item.options) || item.options.length === 0) fail(`AI evaluation case ${entry.id} has an item without options.`);
      if (!isChoice(item.current)) fail(`AI evaluation case ${entry.id} has an invalid current choice.`);
    }
    for (const expected of entry.expected) {
      if (!expected || !itemKeys.has(expected.key) || !isChoice(expected.choice) || !['none', 'intake', 'tni_rule'].includes(expected.basis)) {
        fail(`AI evaluation case ${entry.id} has an invalid expected answer.`);
      }
      const expectedItem = entry.items.find(item => item.key === expected.key);
      if (expected.choice !== null && !expectedItem.options.includes(expected.choice)) {
        fail(`AI evaluation case ${entry.id} expects an option that is not present on the item.`);
      }
      if (expected.intakePath != null && (expected.basis !== 'intake' || typeof expected.intakePath !== 'string')) {
        fail(`AI evaluation case ${entry.id} has an invalid intake path.`);
      }
    }
    const expectedKeys = entry.expected.map(expected => expected.key);
    if (entry.expected.length !== itemKeys.size || new Set(expectedKeys).size !== itemKeys.size) {
      fail(`AI evaluation case ${entry.id} must provide one expected answer for every item.`);
    }
  }
  return parsed.cases;
}

function safeKey(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

export function providerItems(entry) {
  return entry.items.map((item, index) => ({
    ...clone(item),
    id: `eval-${safeKey(entry.id)}-${safeKey(item.key) || index + 1}`,
    q: item.question ?? item.label,
    label: item.label ?? item.question,
    required: false,
    status: 'unknown',
    applyable: true,
  }));
}

export function providerContext(entry) {
  return clone(entry.context);
}

function lunaConfig(env = process.env) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) fail('Missing OPENAI_API_KEY; live evaluation is opt-in and requires that environment variable.');
  return { apiKey, model: DEFAULT_MODEL };
}

function safeSuggestion(item, suggestion) {
  const choice = suggestion?.choice == null ? null : String(suggestion.choice);
  const intakePaths = [...new Set((suggestion?.evidenceSources ?? [])
    .filter(source => source?.basis === 'intake' && typeof source.path === 'string').map(source => source.path))];
  return {
    key: item.key,
    choice,
    basis: suggestion?.basis === 'intake' || suggestion?.basis === 'tni_rule' ? suggestion.basis : 'none',
    ...(suggestion?.intakePath ? { intakePath: String(suggestion.intakePath) } : {}),
    ...(intakePaths.length ? { intakePaths } : {}),
  };
}

export function safeLiveResult(entries, providerCases) {
  return {
    version: 1,
    provider: 'luna',
    cases: entries.map((entry, index) => {
      const run = providerCases[index] ?? {};
      const suggestions = Array.isArray(run.suggestions) ? run.suggestions : [];
      const byKey = new Map(suggestions.map(value => [value?.key, value]));
      return {
        id: entry.id,
        status: run.failed ? 'error' : 'ok',
        suggestions: entry.items.filter(item => byKey.has(item.key)).map(item => safeSuggestion(item, byKey.get(item.key))),
        timingMs: Number.isFinite(run.timingMs) ? Math.max(0, Math.round(run.timingMs)) : null,
        usage: Object.fromEntries(USAGE_METRICS.map(metric => [metric, run.failed ? null : safeMetric(run[metric])])),
      };
    }),
  };
}

export async function runProvider(entries, { env = process.env, clock = performance, call = callModel, config = lunaConfig(env) } = {}) {
  const runs = [];
  for (const entry of entries) {
    const started = clock.now();
    try {
      const collected = collectItems([{ unknown: providerItems(entry) }]);
      // As the panel does: choices naming the client go as placeholders and come back as the page's.
      const named = pseudonymizeChoices(collected.items, entry.context?.record);
      const blocked = [...collected.blocked, ...named.held].map(item => ({ ...item, choice: null, leave: true, basis: 'none', intakePath: null }));
      const result = named.items.length
        ? await suggestLuna(named.items, providerContext(entry), config, { call })
        : { suggestions: [], tokensIn: 0, tokensOut: 0 };
      const suggestions = [...blocked, ...(Array.isArray(result?.suggestions) ? result.suggestions.map(named.restore) : [])];
      runs.push({
        suggestions,
        timingMs: clock.now() - started,
        ...Object.fromEntries(USAGE_METRICS.map(metric => [metric, safeMetric(result?.[metric])])),
      });
    } catch {
      // Never expose provider errors because they may contain prompts, intake values or keys.
      runs.push({ failed: true, suggestions: [], timingMs: clock.now() - started, tokensIn: null, tokensOut: null });
    }
  }
  return safeLiveResult(entries, runs);
}

function expectedMap(entry) {
  return new Map(entry.expected.map(value => [value.key, value]));
}

function resultMap(resultCase) {
  return new Map((Array.isArray(resultCase?.suggestions) ? resultCase.suggestions : []).map(value => [value?.key, value]));
}

export function scoreResult(result, entries) {
  if (!result || result.version !== 1 || !Array.isArray(result.cases)) fail('Saved AI evaluation results must be version 1 with cases.');
  const resultIds = new Set();
  for (const resultCase of result.cases) {
    if (resultIds.has(resultCase?.id)) fail('Saved AI evaluation results must have unique case IDs.');
    resultIds.add(resultCase?.id);
  }
  const resultCases = new Map(result.cases.map(value => [value?.id, value]));
  let total = 0;
  let scoredChoices = 0;
  let correct = 0;
  let expectedAbstentions = 0;
  let correctAbstentions = 0;
  let falsePositives = 0;
  let serviceErrors = 0;
  let unanswered = 0;
  let evidencePaths = 0;
  let evidencePathMatches = 0;
  const timing = [];
  const usageTotals = Object.fromEntries(USAGE_METRICS.map(metric => [metric, 0]));
  const usageAvailable = Object.fromEntries(USAGE_METRICS.map(metric => [metric, false]));
  const usageOverflowed = Object.fromEntries(USAGE_METRICS.map(metric => [metric, false]));
  let usageCases = 0;
  const cases = [];

  for (const entry of entries) {
    const expected = expectedMap(entry);
    const resultCase = resultCases.get(entry.id);
    const serviceError = !resultCase || resultCase.status !== 'ok';
    if (serviceError) serviceErrors++;
    const actual = resultMap(resultCase);
    let casePass = !serviceError;
    let caseUnanswered = false;
    for (const [key, answer] of expected) {
      total++;
      const prediction = actual.get(key);
      const expectedChoice = answer.choice == null ? null : tidy(answer.choice);
      const actualChoice = prediction?.choice == null ? null : tidy(prediction.choice);
      const present = !serviceError && actual.has(key);
      if (!present) {
        if (!serviceError) unanswered++;
        caseUnanswered = !serviceError;
        casePass = false;
      } else {
        if (prediction.basis !== answer.basis) casePass = false;
        if (expectedChoice === null) {
          if (actualChoice === null && prediction.basis === answer.basis) correctAbstentions++;
          else if (actualChoice !== null) {
            falsePositives++;
            casePass = false;
          }
        } else {
          scoredChoices++;
          if (expectedChoice === actualChoice && prediction.basis === answer.basis) correct++;
          else casePass = false;
        }
      }
      if (expectedChoice === null) {
        expectedAbstentions++;
      }
      if (answer.intakePath) {
        evidencePaths++;
        if (present && (prediction.intakePath === answer.intakePath || prediction.intakePaths?.includes(answer.intakePath))) evidencePathMatches++;
        else casePass = false;
      }
    }
    if (Number.isFinite(resultCase?.timingMs)) timing.push(Math.max(0, resultCase.timingMs));
    if (!serviceError) {
      let hasUsage = false;
      for (const metric of USAGE_METRICS) {
        const value = safeMetric(resultCase?.usage?.[metric]);
        if (value == null) continue;
        const totalValue = usageTotals[metric] + value;
        if (!Number.isFinite(totalValue)) {
          usageOverflowed[metric] = true;
          continue;
        }
        hasUsage = true;
        usageAvailable[metric] = true;
        usageTotals[metric] = totalValue;
      }
      if (hasUsage) usageCases++;
    }
    cases.push({ id: entry.id,
      status: serviceError ? (resultCase ? 'service-error' : 'missing') : caseUnanswered ? 'unanswered' : casePass ? 'pass' : 'fail' });
  }

  const sortedTiming = [...timing].sort((a, b) => a - b);
  const middle = Math.floor(sortedTiming.length / 2);
  const median = !sortedTiming.length ? null
    : sortedTiming.length % 2 ? sortedTiming[middle]
      : (sortedTiming[middle - 1] + sortedTiming[middle]) / 2;
  return {
    version: 1,
    provider: result.provider ?? 'unknown',
    cases,
    aggregate: {
      totalChoices: total,
      scoredChoices,
      correctChoices: correct,
      choiceAccuracy: scoredChoices ? correct / scoredChoices : null,
      expectedAbstentions,
      correctAbstentions,
      abstentionCorrectness: expectedAbstentions ? correctAbstentions / expectedAbstentions : null,
      falsePositiveSuggestions: falsePositives,
      serviceErrors,
      unanswered,
      evidencePaths,
      evidencePathMatches,
      evidencePathMatchRate: evidencePaths ? evidencePathMatches / evidencePaths : null,
      timingMs: {
        cases: timing.length,
        total: timing.reduce((sum, value) => sum + value, 0),
        average: timing.length ? timing.reduce((sum, value) => sum + value, 0) / timing.length : null,
        median,
      },
      usage: {
        cases: usageCases,
        ...Object.fromEntries(USAGE_METRICS.map(metric => [metric,
          usageAvailable[metric] && !usageOverflowed[metric] ? usageTotals[metric] : null])),
      },
      expertReviewedCases: entries.filter(entry => entry.expertReviewed === true).length,
      calibration: 'not measured',
    },
  };
}

// The claims-box review and the driver-name check (audit 2026-11-07, AI-06: they had no evaluation).
// Their flags and guesses only are kept and scored: no line text, explanation or prompt.
const NOTE_FLAGS = ['ntl', 'coverageChange', 'generalLiability'];
const NOTE_NUMBERS = ['businessYears', 'businessSince'];

function readSet(file, label, checkEntry) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.cases) || parsed.cases.length === 0) fail(`${label} cases must be version 1 with at least one case.`);
  const seen = new Set();
  for (const entry of parsed.cases) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) fail(`${label} case IDs must be unique.`);
    seen.add(entry.id);
    if (typeof entry.expertReviewed !== 'boolean') fail(`${label} case ${entry.id} must set expertReviewed to a boolean.`);
    if (!entry.record || typeof entry.record !== 'object' || !Array.isArray(entry.expected) || !entry.expected.length) fail(`${label} case ${entry.id} is missing its record or expected answers.`);
    checkEntry(entry);
  }
  return parsed.cases;
}

export function readNotesCases(file = DEFAULT_NOTES_PATH) {
  return readSet(file, 'Claims-box', (entry) => {
    const lines = noteLines(intakeNotes(entry.record));
    for (const x of entry.expected) {
      if (!lines.includes(x?.line)) fail(`Claims-box case ${entry.id} expects a line the review would not send.`);
      if (!NOTE_FLAGS.every((k) => typeof x[k] === 'boolean')) fail(`Claims-box case ${entry.id} must give every flag as a boolean.`);
      if (NOTE_NUMBERS.some((k) => x[k] !== undefined && x[k] !== null && !Number.isInteger(x[k]))) fail(`Claims-box case ${entry.id} has an invalid year.`);
    }
  });
}

export function readNamesCases(file = DEFAULT_NAMES_PATH) {
  return readSet(file, 'Driver-name', (entry) => {
    const sent = new Set(buildNameReview(entry.record)?.ids ?? []);
    for (const x of entry.expected) {
      if (!sent.has(`d${x?.driver}`)) fail(`Driver-name case ${entry.id} expects a driver the check would not send.`);
      if (!NAME_GUESSES.includes(x.guess)) fail(`Driver-name case ${entry.id} has an invalid guess.`);
    }
  });
}

async function runEach(entries, ask, clock) {
  const out = [];
  for (const entry of entries) {
    const started = clock.now();
    try {
      out.push({ id: entry.id, status: 'ok', ...(await ask(entry)), timingMs: Math.max(0, Math.round(clock.now() - started)) });
    } catch {
      // Never expose provider errors: they may contain prompts or keys.
      out.push({ id: entry.id, status: 'error', timingMs: Math.max(0, Math.round(clock.now() - started)) });
    }
  }
  return { cases: out };
}

export function runNotes(entries, { call = callModel, config, clock = performance } = {}) {
  return runEach(entries, async (entry) => {
    const review = buildNotesReview(entry.record);
    if (!review) return { lines: [] };
    const results = parseNotesReview(await call({ apiKey: config.apiKey, proxy: config.proxy, body: review.body }), review);
    return { lines: results.map((x, index) => ({ index, ...Object.fromEntries([...NOTE_FLAGS, ...NOTE_NUMBERS].map((k) => [k, x[k]])) })) };
  }, clock);
}

export function runNames(entries, { call = callModel, config, clock = performance } = {}) {
  return runEach(entries, async (entry) => {
    const review = buildNameReview(entry.record);
    if (!review) return { guesses: [] };
    const results = parseNameReview(await call({ apiKey: config.apiKey, proxy: config.proxy, body: review.body }), review);
    return { guesses: results.map((x) => ({ driver: x.index, guess: x.guess })) };
  }, clock);
}

export function scoreNotes(result, entries) {
  const byId = new Map((result?.cases ?? []).map((x) => [x?.id, x]));
  const flags = Object.fromEntries(NOTE_FLAGS.map((k) => [k, { expectedTrue: 0, truePositives: 0, falsePositives: 0, falseNegatives: 0 }]));
  let lines = 0, correctLines = 0, numbers = 0, correctNumbers = 0, serviceErrors = 0;
  const cases = [];
  for (const entry of entries) {
    const run = byId.get(entry.id);
    if (!run || run.status !== 'ok') { serviceErrors++; cases.push({ id: entry.id, status: run ? 'service-error' : 'missing' }); continue; }
    const sent = noteLines(intakeNotes(entry.record));
    let pass = true;
    for (const x of entry.expected) {
      lines++;
      const got = (run.lines ?? []).find((l) => l?.index === sent.indexOf(x.line));
      let right = !!got;
      for (const k of NOTE_FLAGS) {
        const f = flags[k], said = got?.[k] === true;
        if (x[k]) {
          f.expectedTrue++;
          if (said) f.truePositives++; else { f.falseNegatives++; right = false; }
        } else if (said) { f.falsePositives++; right = false; }
      }
      for (const k of NOTE_NUMBERS) {
        if (x[k] === undefined) continue;
        numbers++;
        if (got?.[k] === x[k]) correctNumbers++; else right = false;
      }
      if (right) correctLines++; else pass = false;
    }
    cases.push({ id: entry.id, status: pass ? 'pass' : 'fail' });
  }
  return { cases, aggregate: { lines, correctLines, lineAccuracy: lines ? correctLines / lines : null, flags, numbers, correctNumbers, serviceErrors,
    expertReviewedCases: entries.filter((e) => e.expertReviewed === true).length, calibration: 'not measured' } };
}

export function scoreNames(result, entries) {
  const byId = new Map((result?.cases ?? []).map((x) => [x?.id, x]));
  let names = 0, correct = 0, opposite = 0, unclearWhenClear = 0, guessedWhenUnclear = 0, serviceErrors = 0;
  const cases = [];
  for (const entry of entries) {
    const run = byId.get(entry.id);
    if (!run || run.status !== 'ok') { serviceErrors++; cases.push({ id: entry.id, status: run ? 'service-error' : 'missing' }); continue; }
    let pass = true;
    for (const x of entry.expected) {
      names++;
      const got = (run.guesses ?? []).find((g) => g?.driver === x.driver)?.guess ?? null;
      if (got === x.guess) { correct++; continue; }
      pass = false;
      // A female name guessed male (or the other way) is the costly mistake; the agent is asked either way.
      if (x.guess !== 'unclear' && got !== 'unclear' && got !== null) opposite++;
      else if (x.guess !== 'unclear' && got === 'unclear') unclearWhenClear++;
      else if (x.guess === 'unclear' && got !== null) guessedWhenUnclear++;
    }
    cases.push({ id: entry.id, status: pass ? 'pass' : 'fail' });
  }
  return { cases, aggregate: { names, correct, accuracy: names ? correct / names : null, opposite, unclearWhenClear, guessedWhenUnclear, serviceErrors,
    expertReviewedCases: entries.filter((e) => e.expertReviewed === true).length, calibration: 'not measured' } };
}

// Saved model answers, by the request they answered: a live run keeps them (--responses), and a
// replay gives today's code the answer to the same request, or nothing for one built differently.
// Only the response envelope is kept (status, model, output, usage). The cases are synthetic.
export const requestKey = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

export function savingCall(call, store) {
  return async (args) => {
    const json = await call(args);
    store[requestKey(args.body)] = { status: json?.status, model: json?.model, output: json?.output, usage: json?.usage };
    return json;
  };
}

export function replayCall(store) {
  return async ({ body }) => {
    const saved = store[requestKey(body)];
    if (!saved) throw new Error('not in the saved responses: run live again');
    return structuredClone(saved);
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

export function parseArgs(args) {
  const live = args.includes('--live');
  const scorePath = valueAfter(args, '--score');
  const replayPath = valueAfter(args, '--replay');
  const casesPath = valueAfter(args, '--cases') ?? DEFAULT_CASES_PATH;
  const notesPath = valueAfter(args, '--notes-cases') ?? DEFAULT_NOTES_PATH;
  const namesPath = valueAfter(args, '--names-cases') ?? DEFAULT_NAMES_PATH;
  const outPath = valueAfter(args, '--out');
  const responsesPath = valueAfter(args, '--responses');
  if (args.includes('--provider')) fail('--provider is no longer supported; Luna is the only live evaluator.');
  if ([live, Boolean(scorePath), Boolean(replayPath)].filter(Boolean).length !== 1) fail('Choose exactly one mode: --live, --replay <responses.json> or --score <saved-result.json>.');
  if (scorePath && outPath) fail('--out is only valid with --live or --replay.');
  if (!live && responsesPath) fail('--responses is only valid with --live.');
  return { live, scorePath, replayPath, casesPath, notesPath, namesPath, outPath, responsesPath };
}

// All three sets' scores; the claims-box and driver-name ones only when the result has them (a saved
// result from before them has page reviews only), their cases read only then.
function scoreAll(result, options, pages) {
  return { ...scoreResult(result, pages),
    ...(result.notes ? { notes: scoreNotes(result.notes, readNotesCases(options.notesPath)) } : {}),
    ...(result.names ? { names: scoreNames(result.names, readNamesCases(options.namesPath)) } : {}) };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const pages = readCases(options.casesPath);
  if (options.scorePath) {
    const saved = JSON.parse(fs.readFileSync(options.scorePath, 'utf8'));
    const output = scoreAll(saved, options, pages);
    console.log(JSON.stringify(output, null, 2));
    return output;
  }
  const store = options.replayPath ? JSON.parse(fs.readFileSync(options.replayPath, 'utf8')) : {};
  const call = options.replayPath ? replayCall(store) : savingCall(callModel, store);
  const config = options.replayPath ? { apiKey: 'replay', model: DEFAULT_MODEL } : lunaConfig();
  // Each run receives a fresh clone of the same synthetic case data.
  const result = { ...(await runProvider(clone(pages), { call, config })),
    notes: await runNotes(readNotesCases(options.notesPath), { call, config }), names: await runNames(readNamesCases(options.namesPath), { call, config }) };
  if (options.outPath) fs.writeFileSync(options.outPath, JSON.stringify(result, null, 2));
  if (options.responsesPath) fs.writeFileSync(options.responsesPath, JSON.stringify(store, null, 2));
  const output = scoreAll(result, options, pages);
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    // Keep command output free of raw provider errors, prompts, intake text and API keys.
    console.error(JSON.stringify({ status: 'error', message: 'AI evaluation could not be completed.' }));
    process.exitCode = 1;
  }
}
