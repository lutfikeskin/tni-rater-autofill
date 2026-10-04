#!/usr/bin/env node
// Offline comparison and opt-in live evaluation for Jev and Luna.
//
// Offline scoring:
//   node scripts/ai-eval.mjs --score result.json
// Live evaluation (never run implicitly):
//   JEV_API_KEY=... node scripts/ai-eval.mjs --live --provider jev
//   OPENAI_API_KEY=... node scripts/ai-eval.mjs --live --provider luna
//   JEV_API_KEY=... OPENAI_API_KEY=... node scripts/ai-eval.mjs --live --provider both --out result.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { collectItems, DEFAULT_MODEL, suggest as suggestJev } from '../src/ai/assist.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CASES_PATH = path.join(ROOT, 'test/ai-eval/cases.json');

const PROVIDER_CONFIG = Object.freeze({
  jev: { keyEnv: 'JEV_API_KEY', modelEnv: 'JEV_MODEL' },
  luna: { keyEnv: 'OPENAI_API_KEY', model: 'gpt-6-luna' },
});

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
    if (new Set(entry.expected.map(expected => expected.key)).size !== itemKeys.size) {
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

function providerConfig(provider, env = process.env) {
  const definition = PROVIDER_CONFIG[provider];
  if (!definition) fail(`Unsupported provider: ${provider}.`);
  const apiKey = env[definition.keyEnv];
  if (!apiKey) fail(`Missing ${definition.keyEnv}; live evaluation is opt-in and requires that environment variable.`);
  return { apiKey, ...(definition.model ? { model: definition.model } : env[definition.modelEnv] ? { model: env[definition.modelEnv] } : {}) };
}

async function loadSuggest(provider) {
  if (provider === 'jev') return suggestJev;
  if (provider === 'luna') {
    let module;
    try {
      module = await import('../src/ai/luna.js');
    } catch {
      fail('Luna provider is unavailable: src/ai/luna.js could not be loaded.');
    }
    const suggest = module.suggest ?? module.default?.suggest ?? module.default;
    if (typeof suggest !== 'function') fail('Luna provider is unavailable: no suggest function was exported.');
    return suggest;
  }
  fail(`Unsupported provider: ${provider}.`);
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

export function safeLiveResult(provider, entries, providerCases) {
  return {
    version: 1,
    provider,
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

export async function runProvider(entries, provider, { env = process.env, clock = performance } = {}) {
  const suggest = await loadSuggest(provider);
  const config = providerConfig(provider, env);
  const runs = [];
  for (const entry of entries) {
    const started = clock.now();
    try {
      const collected = collectItems([{ unknown: providerItems(entry) }]);
      const blocked = collected.blocked.map(item => ({ ...item, choice: null, leave: true, basis: 'none', intakePath: null }));
      const result = collected.items.length
        ? await suggest(collected.items, providerContext(entry), config)
        : { suggestions: [], tokensIn: 0, tokensOut: 0 };
      const suggestions = [...blocked, ...(Array.isArray(result?.suggestions) ? result.suggestions : [])];
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
  return safeLiveResult(provider, entries, runs);
}

function expectedMap(entry) {
  return new Map(entry.expected.map(value => [value.key, value]));
}

function resultMap(resultCase) {
  return new Map((Array.isArray(resultCase?.suggestions) ? resultCase.suggestions : []).map(value => [value?.key, value]));
}

export function scoreResult(result, entries) {
  if (!result || result.version !== 1 || !Array.isArray(result.cases)) fail('Saved AI evaluation results must be version 1 with cases.');
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
  const median = sortedTiming.length ? sortedTiming[Math.floor((sortedTiming.length - 1) / 2)] : null;
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

export function safeProvidersResult(results) {
  if (!Array.isArray(results) || results.length === 0 || results.some(result => !result || result.version !== 1 || !result.provider)) {
    fail('Provider results must be version 1 safe results.');
  }
  return {
    version: 1,
    providers: Object.fromEntries(results.map(result => [result.provider, result])),
  };
}

export function scoreSavedResult(saved, entries) {
  if (saved?.version !== 1) fail('Saved AI evaluation results must be version 1.');
  if (saved.providers && typeof saved.providers === 'object' && !Array.isArray(saved.providers)) {
    return Object.entries(saved.providers).map(([provider, result]) => scoreResult({ ...result, provider: result?.provider ?? provider }, entries));
  }
  return [scoreResult(saved, entries)];
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

export function parseArgs(args) {
  const live = args.includes('--live');
  const scorePath = valueAfter(args, '--score');
  const casesPath = valueAfter(args, '--cases') ?? DEFAULT_CASES_PATH;
  const provider = valueAfter(args, '--provider');
  const outPath = valueAfter(args, '--out');
  if (live === Boolean(scorePath)) fail('Choose exactly one mode: --live or --score <saved-result.json>.');
  if (live && !['jev', 'luna', 'both'].includes(provider)) fail('Live evaluation requires --provider jev, luna or both.');
  if (!live && (provider || outPath)) fail('--provider and --out are only valid with --live.');
  return { live, scorePath, casesPath, provider, outPath };
}

export function providersFor(value) {
  return value === 'both' ? ['jev', 'luna'] : [value];
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const entries = readCases(options.casesPath);
  if (!options.live) {
    const saved = JSON.parse(fs.readFileSync(options.scorePath, 'utf8'));
    const reports = scoreSavedResult(saved, entries);
    const output = reports.length === 1 ? reports[0] : reports;
    console.log(JSON.stringify(output, null, 2));
    return output;
  }

  const reports = [];
  const safeResults = [];
  for (const provider of providersFor(options.provider)) {
    // Each provider receives a fresh clone of the same case data and no provider-specific facts.
    const result = await runProvider(clone(entries), provider);
    safeResults.push(result);
    if (options.outPath && options.provider !== 'both') fs.writeFileSync(options.outPath, JSON.stringify(result, null, 2));
    reports.push(scoreResult(result, entries));
  }
  if (options.outPath && options.provider === 'both') {
    fs.writeFileSync(options.outPath, JSON.stringify(safeProvidersResult(safeResults), null, 2));
  }
  const output = reports.length === 1 ? reports[0] : reports;
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    // Keep command output free of raw provider errors, prompts, intake text and API keys.
    console.error(JSON.stringify({ status: 'error', message: 'AI evaluation could not be completed.' }));
    process.exitCode = 1;
  }
}
