// @ts-check
// Injected into rater pages (every frame) by the side panel, as one classic script with no imports:
// scripts/lib/kit.mjs builds it from this source and the shared modules it imports (the package
// writes it to src/content/pagekit.js).
// Exposes globalThis.__raterKit = { fill, progress, stop, answer, markKey, reveal, readBack, present, receipt, aiBanner, capture, clear, … }.

/** @import { FillOptions, FillReport, PlanStep } from '../../types.js' */

import { kitTrace, setTracing, isTracing } from './trace.js';
import { adapter, pageBusy, perfNow, stepKey, stopStepOn, settle, getKnownStopSteps } from './adapter.js';
import { collectControls, fieldKey, describe, invalidControl } from './dom.js';
import { mark, clear, markKey, reveal, aiBanner } from './marks.js';
import { listed, unitList, unitListsNow, unitFormsNow } from './units.js';
import { guardEdits, answerEdits, getAnswerEditSession, STOP_STEP_HALT, EDIT_HALT_ANSWERS } from './guard.js';
import { capture, receipt, readBack, present, signature, decisionSnapshot } from './capture.js';
import { apply, agreesWith } from './apply.js';
import { fill, progress, stop } from './cursor.js';

(() => {
  // This build of the kit (stamped by scripts/package.mjs): one left in the page by another build,
  // from before an extension reload or update, is replaced rather than reused.
  const BUILD = 'source';
  if (globalThis.__raterKit?.version === 94 && globalThis.__raterKit.build === BUILD) return;

  /**
   * Puts answers the agent accepted from the AI assistant (or that it was allowed to pick itself)
   * into their fields.
   * @param {Array<{ key: string, label?: string, value: any, note?: string, expected?: any }>} answers
   * @param {string[]} [expectedSnapshots]
   * @param {string} [guardToken]
   * @param {{ stopSteps?: string[], by?: 'ai' | 'agent', trace?: boolean }} [options]
   * @returns {Promise<any[]>}
   */
  async function answer(answers, expectedSnapshots, guardToken, { stopSteps = getKnownStopSteps(), by = 'ai', trace = false } = {}) {
    // Asked with `trace` (a developer recording runs on the tab): it says what it does as a fill
    // does, by whom (`source`), so an AI apply isn't read as a fill (REC-14, 2026-11-07).
    if (!trace) return answerAll(answers, expectedSnapshots, guardToken, { stopSteps, by });
    setTracing(true);
    kitTrace('run', { on: true, steps: answers?.length ?? 0, source: by });
    try {
      const results = await answerAll(answers, expectedSnapshots, guardToken, { stopSteps, by });
      kitTrace('run', { on: false, filled: results.filter((r) => r.ok).length, halted: false, source: by });
      return results;
    } finally {
      setTracing(false);
    }
  }

  /**
   * @param {any[]} answers
   * @param {string[] | null | undefined} expectedSnapshots
   * @param {string | undefined} guardToken
   * @param {{ stopSteps: string[], by: 'ai' | 'agent' }} options
   * @returns {Promise<any[]>}
   */
  async function answerAll(answers, expectedSnapshots, guardToken, { stopSteps, by }) {
    const agent = by === 'agent';
    if (stopStepOn(stopSteps)) return answers.map((a) => ({ key: a.key, label: a.label, ok: false, reason: STOP_STEP_HALT }));
    const answerEditSession = getAnswerEditSession();
    if (guardToken && answerEditSession?.token !== guardToken) {
      return answers.map(a => ({ key: a.key, label: a.label, ok: false,
        reason: 'the page or frame changed while applying the answers; request fresh suggestions' }));
    }
    if (expectedSnapshots && !expectedSnapshots.includes(decisionSnapshot())) {
      return answers.map(a => ({ key: a.key, label: a.label, ok: false, reason: 'the page changed since the assistant evaluated it; request fresh suggestions' }));
    }
    const serverBacked = adapter().serverBacked();
    const find = (key, label) => {
      const same = collectControls().filter((c) => fieldKey(c) === key);
      return same.length > 1 ? same.find((c) => c.label === label) ?? null : same[0] ?? null;
    };
    const results = [];
    const editedQuestions = answerEditSession?.questions ?? new Map();
    const edited = (key) => editedQuestions.has(key);
    const releaseEditGuard = answerEditSession ? () => {} : guardEdits((key, c) => {
      if (!edited(key)) editedQuestions.set(key, c.label ?? null);
    });
    try {
      for (const a of answers) {
        if (editedQuestions.size) { results.push({ key: a.key, label: a.label, ok: false, reason: EDIT_HALT_ANSWERS }); continue; }
        const c = find(a.key, a.label);
        if (!c) { results.push({ key: a.key, label: a.label, ok: false, reason: 'the question is no longer on this page' }); continue; }
        if (a.expected) {
          const d = describe(c);
          const options = c.kind === 'checkbox' ? ['checked', 'unchecked'] : d.options;
          const changed = [c.label !== a.label && 'label', c.kind !== a.expected.kind && 'type',
            (d.section || null) !== (a.expected.section || null) && 'section',
            JSON.stringify(options) !== JSON.stringify(a.expected.options) && 'options',
            (d.current ?? null) !== (a.expected.current ?? null) && 'selection'].filter(Boolean);
          if (changed.length) {
            results.push({ key: a.key, label: a.label, ok: false, reason: `the field changed (${changed.join(', ')}) since the assistant evaluated it; request a fresh suggestion` });
            continue;
          }
        }
        const id = `${agent ? 'agent' : 'ai'}:${a.key}`;
        const name = agent ? 'Your answer' : 'AI suggestion';
        const step = c.kind === 'checkbox'
          ? { id, name, kind: 'bool', value: /^(checked|yes|true)$/i.test(String(a.value)) }
          : { id, name, value: String(a.value) };
        let result;
        const t0 = Date.now();
        try { result = await apply(step, c); } catch (e) { result = { ok: false, reason: String(e?.message ?? e) }; }
        const tApplied = Date.now();
        if (result.ok) {
          const settled = await settle(serverBacked ? { why: 'answer' } : { quietMs: 250, maxMs: 3000, why: 'answer' });
          const fresh = find(a.key, a.label);
          if (edited(a.key)) result = { ok: false, reason: 'you changed this question yourself while the answer went in; your answer stays' };
          else if (!settled) result = { ok: false, reason: 'the page did not settle after the answer' };
          else if (!fresh) result = { ok: false, reason: 'the field disappeared after the answer; check the page' };
          else if (invalidControl(fresh) || !agreesWith(step, fresh)) result = { ok: false, reason: 'the page did not keep the answer; check it' };
          else mark(fresh, agent ? 'agent' : 'ai', a.note ?? (agent ? 'your answer, from the side panel' : 'answer suggested by the AI assistant — check it'));
        }
        if (!result.ok && !edited(a.key)) { const now = find(a.key, a.label); if (now) mark(now, 'failed', `${agent ? 'Your answer' : 'AI answer'} not accepted: ${result.reason}`); }
        results.push({ key: a.key, label: a.label, ok: result.ok, shown: result.shown ?? null, reason: result.reason ?? null });
        if (isTracing()) kitTrace('answer', { field: { key: a.key, label: c.label ?? '' }, stepKind: step.kind ?? null, ok: !!result.ok, start: t0, applyMs: tApplied - t0, source: by });
      }
      for (const r of results) if (edited(r.key)) r.protected = true;
      for (const [key, label] of editedQuestions) {
        if (!results.some((r) => r.key === key)) results.push({ key, label, ok: false, protected: true, reason: 'you changed this question yourself while the AI answers went in; your answer stays' });
      }
      return results;
    } finally {
      releaseEditGuard();
    }
  }

  /**
   * A fill asked with trace (the developer recording) says what it does while it runs.
   * @param {PlanStep[]} plan
   * @param {FillOptions} [options]
   * @returns {Promise<FillReport>}
   */
  async function tracedFill(plan, options = {}) {
    setTracing(!!options?.trace);
    kitTrace('run', { on: true, steps: plan?.length ?? 0 });
    // How long the page was hidden while it filled (`hiddenMs`, only when it was): Chrome slows a
    // hidden tab's timers, which the fill's waits run on (audit 2026-11-07, FLOW-12). Measured, not
    // worked around.
    let hiddenMs = 0;
    let hiddenSince = document.visibilityState === 'hidden' ? perfNow() : null;
    const seen = () => {
      if (document.visibilityState === 'hidden') hiddenSince ??= perfNow();
      else if (hiddenSince != null) { hiddenMs += perfNow() - hiddenSince; hiddenSince = null; }
    };
    document.addEventListener('visibilitychange', seen);
    try {
      const report = await fill(plan, options);
      kitTrace('run', { on: false, filled: report?.filled?.length ?? 0, halted: !!report?.halted });
      if (hiddenSince != null) hiddenMs += perfNow() - hiddenSince;
      if (report && hiddenMs >= 1) report.hiddenMs = Math.round(hiddenMs);
      return report;
    } finally {
      document.removeEventListener('visibilitychange', seen);
      setTracing(false);
    }
  }

  globalThis.__raterKit = {
    version: 94,
    build: BUILD,
    fill: tracedFill,
    progress,
    stop,
    answer,
    answerEdits,
    listed,
    unitList,
    unitListsNow,
    markKey,
    reveal,
    readBack,
    present,
    receipt,
    aiBanner,
    capture,
    clear,
    signature,
    decisionSnapshot,
    busy: pageBusy,
    step: stepKey,
    unitFormsNow,
  };
})();
