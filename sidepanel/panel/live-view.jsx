// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
// The side panel's live fill view in React: the answers going in now, one row each as the page takes
// them, the items left for the agent as the fill judges them (top to bottom: only questions above
// where it has got to), all in the page's order (liveEntries), and a row for the one coming: read
// from the page (pagekit progress, watchFill), nothing typed or guessed here. Shown in the page view
// in place of the report while a fill on the tab in front runs.
// One part of the panel; sidepanel.js mounts it (mountLive).
import { memo, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { fillShown, liveEntries, liveSource, phaseSaid } from './live.js';
// The report's words for an answer's source, so the live list and the report say it alike.
import { SOURCE } from './messages.js';
// agent defaults: an answer the agent's own default gave.
import { isOwnDefault } from './agent-defaults/store.js';

// A source's tag class: the report's colors (answerSource, fill.js).
const TAG_CLASS = { edited: 'you', own: 'own', standard: 'standard', derived: 'derived' };

// What a need row says, by the item's kind; any other kind needs the agent's answer.
const NEED_SAID = { failed: 'Couldn’t fill' };

// An answer in, tagged with where it came from in the report's words (liveSource). Drawn again only
// when what it shows changes, or it stops being the fresh one.
const AnswerRow = memo(function AnswerRow({ label, shown, source, fresh }) {
  const tag = source ? SOURCE.tag[source] : null;
  return (
    <div className={`row${fresh ? ' fresh' : ''}`}>
      <div className="row-head">
        <span className="row-icon" aria-hidden="true">✓</span>
        <span className="row-text"><span className="row-label">{label || 'Answer'}</span><span className="row-value">{shown || 'filled'}</span></span>
        {tag ? <span className={`tag ${TAG_CLASS[source]}`} title={tag.title}>{tag.text}</span> : null}
      </div>
    </div>
  );
});

// A question the fill has judged is the agent's: one it couldn't fill, or one that needs their answer.
const NeedRow = memo(function NeedRow({ label, kind }) {
  const failed = kind === 'failed';
  return (
    <div className={`row need${failed ? ' failed' : ''}`}>
      <div className="row-head">
        <span className="row-icon" aria-hidden="true">{failed ? '!' : '?'}</span>
        <span className="row-text"><span className="row-label">{label || 'Question'}</span><span className="row-value">{NEED_SAID[kind] ?? 'Needs your answer'}</span></span>
      </div>
    </div>
  );
});

// The row for the one coming: what the kit is doing (phaseSaid), or that the page isn't answering.
function TypingRow({ label, value }) {
  return (
    <div className="row typing">
      <div className="row-head">
        <span className="row-icon" aria-hidden="true"><span className="spinner" /></span>
        <span className="row-text"><span className="row-label">{label}</span><span className="row-value">{value}</span></span>
      </div>
    </div>
  );
}

// Each entry's React key: its field in its frame (an answer and an item apart), and a count for a
// field listed again, so a row keeps its place as the answers come in and isn't drawn again.
function entryKeys(entries) {
  const seen = new Map();
  return entries.map(({ row, item }) => {
    const x = row ?? item;
    const base = `${row ? 'a' : 'i'}|${x.frame ?? ''}|${x.key ?? x.label ?? ''}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}

// `view`: the page view that scrolls (#view). The list follows the answers only while the agent is
// at its end (or it is new): one who scrolled up to read the page's notes isn't pulled back down
// every half second.
function LiveView({ view }) {
  const f = useStore(panelStore, (s) => s.fillingFor);
  const filling = useStore(panelStore, (s) => s.filling);
  const tabId = useStore(panelStore, (s) => s.tab?.id);
  // The fields the agent set or corrected, and those worked out from them: their answers say Your edit.
  const agentEdited = useStore(panelStore, (s) => s.intake?.agentEdited);
  const agentDerived = useStore(panelStore, (s) => s.intake?.agentDerived);
  const edited = [...(agentEdited ?? []), ...(agentDerived ?? [])];
  const list = useRef(null);
  // The answers the list last drew, and whether it was shown: a list just shown follows its end,
  // answers or not (review of #244: a phase before the first answer pulled an agent who had
  // scrolled up back down).
  const drawn = useRef([]);
  const shown = useRef(false);
  const on = !!filling && fillShown(f) && f.tabId === tabId;
  const rows = on ? f.rows ?? [] : [];
  const follow = on && (!shown.current || view.scrollHeight - view.scrollTop - view.clientHeight < 80);
  // The answer that just went in (the last one new since the list was drawn) is marked fresh.
  const had = new Set(drawn.current);
  const fresh = rows.findLast((x) => !had.has(x)) ?? null;
  useLayoutEffect(() => {
    drawn.current = rows;
    shown.current = on;
    if (follow) list.current?.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
  });
  if (!on) return null;
  const entries = liveEntries(rows, f.items ?? [], f.frames ?? []);
  const keys = entryKeys(entries);
  const [label, value] = f.unanswered ? ['Waiting for the page', 'It isn’t answering'] : phaseSaid(f.phase, rows.length);
  return (
    <div id="live" className="rows live" ref={list}>
      {entries.map(({ row: x, item }, i) => (item
        ? <NeedRow key={keys[i]} label={item.label} kind={item.kind} />
        : <AnswerRow key={keys[i]} label={x.label} shown={x.shown} source={liveSource(x, isOwnDefault(x, 'filled'), edited)} fresh={x === fresh} />))}
      {f.stopping ? null : <TypingRow label={label} value={value} />}
    </div>
  );
}

// Draws the live list into `root` (#live-root) for the page view `view` (#view), from the panel's store.
function mountLive(root, view) {
  createRoot(root).render(<LiveView view={view} />);
}

export { LiveView, entryKeys, mountLive };
