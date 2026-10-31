// The side panel's page list as data: each row of a page's report (an answer that went in, or an
// item left for the agent) is a record in its report's `list`, holding what the row shows and what
// happened to it since the fill (settled, changed on the page, gone, opened). The panel changes the
// records and the report draws them (fill.js drawRow); what is left, the filters' counts and the
// dock read them, not the drawing. No DOM.
// One part of the panel; sidepanel.js wires the parts together.
import { agentPickable, choicesOf, finishLeftOk } from './report-model.js';

// An answer in the page's list (groupRows' row): `kind` is its source ('intake', 'derived',
// 'standard', 'edited'), or what it is when it's no answer of ours ('clicked', 'page', 'yours',
// 'changed'). `changed`: what the page shows now where that isn't the fill's answer (checkAnswers);
// `change`: the choices Change answer offers ({ x, options, current }).
function answerRecord(row) {
  return { ...row, type: 'answer', kind: row.kind ?? (row.edited ? 'edited' : row.standard ? 'standard' : row.from ? 'derived' : 'intake'),
    open: false, gone: false, changed: null, change: null, head: null, note: null, where: null };
}

// An item left for the agent: why, and its choices where the panel may put the agent's pick in
// (agentPickable). `now`: what the page shows for it, only as the page has it, never for a question
// off screen; `pressed`: the choice shown as the page's answer; `offered`: the options of a failed
// choice the panel can't put in. `settled`: 'answered', 'picked', 'marked' (with `undo`) or 'ai';
// `ai`, `aiPick`, `aiAccept`: the AI's suggestion on it, its pick among the choices, and accepting it
// (renderAi). `finish`: an item the quote may finish without (finishLeftOk).
function needRecord(x, carrier, page, open = false) {
  const pickable = agentPickable(x, carrier, page);
  const kind = x.mark === 'failed' ? 'failed' : pickable ? 'need' : 'yours';
  const now = x.controlKind !== 'text' && x.current && !x.offPage ? x.current : null;
  return { type: 'need', x, label: x.label || x.name, key: x.key ?? '', field: x.label ?? '', offPage: !!x.offPage, kind, pickable,
    icon: { failed: '!', need: '?', yours: '•' }[kind], wait: { failed: 'Couldn’t fill', need: 'Needs your answer', yours: 'Left for you' }[kind],
    finish: finishLeftOk(carrier, x), options: [...new Set(choicesOf(x.controlKind, x.options))], offered: !pickable && x.mark === 'failed' ? x.options ?? [] : null,
    now, pressed: now, open, gone: false, settled: null, pending: false, head: null, note: null, where: null, ai: null, aiPick: null, aiAccept: null };
}

// Which question an item is, as the AI names it: its field and label.
function needId(rec) { return `${rec.x.key}|${rec.x.label}`; }

// A row's head as it says now: its icon, what it says and its source tag, over what it said as the
// fill ended. `icon` and `value` change only when given; the tag is replaced (none: null).
function setHead(rec, { icon = null, value = null, tag = null }) {
  rec.head = { ...rec.head, ...(icon != null ? { icon } : {}), ...(value != null ? { value } : {}), tag };
}

// The head drawn: setHead's word over what the row said as the fill ended (`tag`, the answer's
// source tag then; an item has none). An answer's value is what the page shows now (`value`).
function rowHead(rec, tag = null) {
  const icon = rec.type === 'need' ? rec.icon : ['page', 'yours', 'changed'].includes(rec.kind) ? '•' : '✓';
  return { icon: rec.head?.icon ?? icon, value: rec.head?.value ?? (rec.type === 'need' ? rec.wait : rec.value),
    tag: rec.head && 'tag' in rec.head ? rec.head.tag : tag };
}

// The row's classes: what it is, and what happened to it (the report's filters and colours).
function rowClass(rec) {
  const kind = rec.type === 'need' ? `row need${rec.kind === 'need' ? '' : ` ${rec.kind}`}`
    : `row${{ page: ' page', changed: ' page', clicked: ' clicked', yours: ' yours' }[rec.kind] ?? ''}${rec.fresh ? ' fresh' : ''}`;
  return `${kind}${rec.open ? ' open' : ''}${rec.settled ? ' resolved' : ''}${rec.pending ? ' pending' : ''}${rec.changed ? ' changed' : ''}${rec.gone ? ' gone' : ''}`;
}

// An item left for the agent that is settled now: answered on the page ('answered'), put in from
// its row ('picked', with what the page shows), or marked done ('marked', with `undo`). It leaves
// "need you" at once, without a refill: its row says the answer is theirs.
function settleRow(rec, how, undo = null, value = null) {
  rec.settled = how;
  setHead(rec, { icon: '✓', value: value ?? (how === 'marked' ? 'Marked done' : 'Answered on the page'),
    tag: { kind: 'you', text: 'You', title: how === 'picked' ? 'Your answer, put in from the panel' : 'Your answer' } });
  rec.note = { text: how === 'answered' ? '✓ You answered it on the page.' : how === 'picked' ? '✓ Put in for you. No fill changes it now.'
    : '✓ Marked done: won’t be filled or waited on.', bad: false, undo: how === 'marked' ? undo : null };
}

// A marked item open again (Undo): its row says what it waits on, and its note is empty.
function reopenRow(rec) {
  rec.settled = null;
  rec.head = null;
  rec.note = null;
}

// What the page shows and offers for an item now (checkItems: pagekit present), or nothing when its
// field isn't on screen (`live` null): what it said before is never left as the page's.
function showLive(rec, live) {
  const current = live && !live.shared && rec.x.controlKind !== 'text' ? live.current ?? null : null;
  rec.now = current;
  if (!live) return;
  if (rec.offered) rec.offered = live.options ?? [];
  const next = rec.pickable ? [...new Set(choicesOf(rec.x.controlKind, live.options))] : [];
  if (!next.length) return;
  // Other choices than shown: the row offers the page's now.
  if (next.length !== rec.options.length || next.some((o, i) => o !== rec.options[i])) {
    rec.x.options = live.options;
    rec.options = next;
  }
  rec.pressed = current;
}

// What is left for the agent in a list: its items not settled since, a question gone from the page
// not counted (it holds nothing); `otherLeft`, those the quote can't finish without.
function leftOf(list = []) {
  const open = list.filter((r) => r.type === 'need' && !r.gone && !r.settled);
  return { left: open.length, otherLeft: open.filter((r) => !r.finish).length };
}

// The filters' counts: every row, those needing the agent, and the rest.
function listCounts(list = []) {
  const needs = list.filter((r) => r.type === 'need' && !r.settled).length;
  return { all: list.length, needs, done: list.length - needs };
}

export { answerRecord, leftOf, listCounts, needId, needRecord, reopenRow, rowClass, rowHead, setHead, settleRow, showLive };
