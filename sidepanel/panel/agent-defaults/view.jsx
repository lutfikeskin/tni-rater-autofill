// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
// Settings → Your defaults (docs/agent-defaults-spec.md, "TNI defaults (basic)" and "Advanced"): the
// agent's own amounts in place of TNI's standards, kept in a profile the agent picks, never under their
// initials alone. One folded row, as AI's, that says the profile and how many amounts it changes; Per
// carrier, folded inside, gives each carrier its own: an amount only that carrier sells, TNI's there,
// or "Ask me". Drawn from the store's `agentDefaults` (store.js) and `defaultsInitials`; what its
// controls do is `act.defaults` (store.js defaultsActs).
// Also the client strip's pill once the quote's question is answered (DefaultsChip, state.defaultsChip).
// Both hidden while the feature is off in this copy (state.defaultsOn, store.js loadDefaults).
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { panelStore } from '../state-store.js';
import { REGISTRY, RELEASED_TO_AGENTS, amountSaid, defaultsForLog, effectiveDefaults } from '../../../src/agent-defaults/index.js';
import { STANDARD_IDS } from '../../../src/standards.js';
import { DEFAULTS_CARRIERS } from './store.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One standard's row: TNI's amount first, then every amount all carriers sell.
function DefaultRow({ entry, value, onPick }) {
  const tni = STANDARD_IDS[entry.id]();
  const choices = entry.choices.all.filter((c) => !same(c, tni));
  const index = value == null ? -1 : choices.findIndex((c) => same(c, value));
  const id = `default-${entry.id}`;
  return (
    <label className="opt" htmlFor={id} title={`TNI's: ${amountSaid(tni)}`}>
      <span className="opt-text"><b>{entry.label}</b></span>
      <select id={id} value={String(index)} onChange={(e) => { const i = Number(e.target.value); onPick(i >= 0 ? choices[i] : null); }}>
        <option value="-1">{`TNI's (${amountSaid(tni)})`}</option>
        {choices.map((c, i) => <option key={i} value={String(i)}>{amountSaid(c)}</option>)}
      </select>
    </label>
  );
}

// A carrier's own row (Advanced): "As above" (the basic row's amount), TNI's there when the basic
// row replaces it, each amount that carrier sells, or "Ask me" (the agent answers it on that carrier).
function CarrierRow({ carrier, entry, basic, pick, onPick }) {
  const tni = STANDARD_IDS[entry.id]();
  const above = basic ?? tni;
  const amounts = (entry.choices[carrier.id] ?? []).filter((c) => !same(c, above) && !same(c, tni));
  const index = pick && 'value' in pick ? amounts.findIndex((c) => same(c, pick.value)) : -1;
  const current = !pick ? 'same' : 'ask' in pick ? 'ask' : basic && same(pick.value, tni) ? 'tni' : index >= 0 ? String(index) : 'same';
  const id = `advanced-${carrier.id}-${entry.id}`;
  const pickOf = (v) => (v === 'same' ? null : v === 'ask' ? 'ask' : v === 'tni' ? tni : amounts[Number(v)]);
  return (
    <label className="opt" htmlFor={id}>
      <span className="opt-text"><b>{entry.label}</b></span>
      <select id={id} value={current} onChange={(e) => onPick(pickOf(e.target.value))}>
        <option value="same">{`As above (${amountSaid(above)})`}</option>
        {basic ? <option value="tni">{`TNI's (${amountSaid(tni)})`}</option> : null}
        {amounts.map((c, i) => <option key={i} value={String(i)}>{amountSaid(c)}</option>)}
        <option value="ask">Ask me</option>
      </select>
    </label>
  );
}

// What Per carrier does, as the first line inside it once opened: it says which answers become the
// agent's, so it can't live in a tooltip that keyboard users never see (review of #305).
const ABOUT_ADVANCED = "A carrier's own amount, or Ask me to answer it yourself on that carrier. Answers that rest on it (PIP beside Medical payments, GEICO's rental beside the deductibles) become yours too.";

// Per carrier: the card's last row, folded until the agent opens it; the row says how many carrier
// picks the profile has. One group per carrier inside.
function Advanced({ profile, act }) {
  const basic = effectiveDefaults({ values: profile.values }, null);
  const picks = Object.values(profile.carriers ?? {}).reduce((n, own) => n + Object.keys(own).length, 0);
  return (
    <details id="defaults-advanced" className="fold sub-fold">
      <summary className="opt"><span className="opt-text"><b>Per carrier</b></span><span className="fold-note">{picks ? `${picks} carrier ${picks === 1 ? 'pick' : 'picks'}` : 'Same everywhere'}</span><span className="chev" aria-hidden="true">›</span></summary>
      <div className="defaults-carriers">
        <p id="defaults-advanced-about" className="fine card-note">{ABOUT_ADVANCED}</p>
        {DEFAULTS_CARRIERS.map((carrier) => (
          <div key={carrier.id} className="defaults-carrier" id={`defaults-${carrier.id}`}>
            <div className="eyebrow">{carrier.name}</div>
            {REGISTRY.filter((e) => !e.locked && e.choices[carrier.id]).map((entry) => (
              <CarrierRow key={entry.id} carrier={carrier} entry={entry} basic={'value' in (basic[entry.id] ?? {}) ? basic[entry.id].value : null}
                pick={profile.carriers?.[carrier.id]?.[entry.id] ?? null} onPick={(v) => act.setCarrier(carrier.id, entry.id, v)} />
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

// What the section does, on its row's tooltip. A profile that changes nothing asks nothing (store.js
// replacesAny), so the question is promised only when it changes something (review of #305).
const ABOUT_DEFAULTS = "Your own amounts in place of TNI's standards. When your profile changes any, each quote asks first. Client requests on the intake always win.";

// The row's note: the profile in force and how many amounts it changes, or why there is none.
function summaryOf(initials, active) {
  if (!initials) return 'Set your initials first';
  if (!active) return "TNI's everywhere";
  const changed = defaultsForLog(active).length;
  return `${active.name} · ${changed ? `${changed} changed` : "same as TNI's"}`;
}

export function TniDefaults({ act }) {
  const on = useStore(panelStore, (s) => !!s.defaultsOn);
  const stored = useStore(panelStore, (s) => s.agentDefaults);
  const initials = useStore(panelStore, (s) => s.defaultsInitials);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  if (!on) return null;
  const profiles = Object.entries(stored?.profiles ?? {});
  const active = stored?.active ? stored.profiles[stored.active] : null;
  const create = () => { act.create(name); setName(''); setNaming(false); };
  return (
    <div className="group" id="tni-defaults">
      <details id="defaults-fold" className="fold">
        <summary className="list-row" title={ABOUT_DEFAULTS}><svg className="fold-icon" aria-hidden="true"><use href="#sliders" /></svg><span className="fold-name">Your defaults</span><span id="defaults-summary" className="fold-note">{summaryOf(initials, active)}</span><span className="chev" aria-hidden="true">›</span></summary>
        <div className="card">
          {!initials ? <p className="fine card-note" role="status">Set your initials above to use your own defaults.</p> : (
            <>
              <label className="opt" htmlFor="defaults-profile">
                <span className="opt-text"><b>Profile</b></span>
                <select id="defaults-profile" value={stored?.active ?? ''} onChange={(e) => act.pick(e.target.value || null)}>
                  <option value="">{"None: TNI's everywhere"}</option>
                  {profiles.map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
                </select>
              </label>
              {naming ? (
                <div className="defaults-actions">
                  <input id="defaults-new-name" type="text" maxLength={40} autoComplete="off" placeholder="Your name, e.g. Jordan K." value={name}
                    onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
                  <button type="button" className="primary small-btn" disabled={!name.trim()} onClick={create}>Create</button>
                  <button type="button" className="ghost small-btn" onClick={() => setNaming(false)}>Cancel</button>
                </div>
              ) : (
                <div className="defaults-actions">
                  <button type="button" id="defaults-new" className="ghost small-btn" onClick={() => setNaming(true)}>New profile</button>
                  {active ? <button type="button" id="defaults-delete" className="ghost small-btn danger" onClick={() => { if (confirm(`Delete ${active.name}'s defaults?`)) act.remove(stored.active); }}>Delete profile</button> : null}
                </div>
              )}
              {active ? REGISTRY.filter((e) => !e.locked).map((entry) => (
                <DefaultRow key={entry.id} entry={entry} value={active.values?.[entry.id]?.value ?? null} onPick={(v) => act.set(entry.id, v)} />
              )) : null}
              {active ? <Advanced profile={active} act={act} /> : null}
            </>
          )}
        </div>
      </details>
    </div>
  );
}

// The quote's defaults once its question is answered: a pill in the client strip that says it in
// words ("2 yours" in teal; "TNI's" plain), and on a click what this quote fills and the switch to the
// other. Closes on a click elsewhere, Escape, or its own action.
export function DefaultsChip() {
  const on = useStore(panelStore, (s) => !!s.defaultsOn);
  const chip = useStore(panelStore, (s) => s.defaultsChip);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  // Gone with the pill (a new quote, Clear, the feature hidden): it never comes back open by itself.
  useEffect(() => { if (!on || !chip) setOpen(false); }, [on, chip]);
  if (!on || !chip) return null;
  const mine = chip.choice === 'mine';
  return (
    <span ref={box} className="defaults-chip">
      <button type="button" id="defaults-chip" className={`defaults-pill${mine ? ' own' : ''}`} aria-label={chip.label} title={chip.label}
        aria-expanded={open} aria-controls="defaults-pop" onClick={() => setOpen(!open)}>
        <svg aria-hidden="true"><use href="#sliders" /></svg>
        <span aria-hidden="true">{chip.short}</span>
      </button>
      <div id="defaults-pop" className="defaults-pop" role="dialog" aria-label={chip.title} hidden={!open}>
        <div className="pop-head"><b>{chip.title}</b><span>{chip.sub}</span></div>
        {chip.lines.map((l, i) => (
          <div key={i} className="pop-line"><span>{l.label}</span><span className="pop-value">{l.value}{l.tni ? <small>{`TNI's ${l.tni}`}</small> : null}</span></div>
        ))}
        <p className="fine pop-note">{chip.after}</p>
        <div className="pop-actions">
          <button type="button" className="ghost small-btn" onClick={() => { setOpen(false); chip.action.onClick(); }}>{chip.action.label}</button>
          {mine ? <span className="fine">Marked teal below</span> : null}
        </div>
      </div>
    </span>
  );
}

// The developer's switch (Settings → Advanced, for setup only), shown in every copy but agents' store
// build: the whole feature on or off in this copy, to see the panel as agents will before TNI's
// managers approve it (RELEASED_TO_AGENTS, src/agent-defaults/index.js). `act`: store.js setDefaultsShown.
export function DefaultsDevSwitch({ act }) {
  const dev = useStore(panelStore, (s) => !!s.defaultsDev);
  const on = useStore(panelStore, (s) => !!s.defaultsOn);
  if (!dev || !act) return null;
  return (
    <label id="defaults-dev-row" className="test-run" title="Only in this unpacked copy. Agents' store build has it only once RELEASED_TO_AGENTS is true.">
      <input id="defaults-shown" type="checkbox" checked={on} onChange={(e) => act(e.target.checked)} />
      {RELEASED_TO_AGENTS ? 'Your defaults (released to agents)' : 'Your defaults (developer only: not released to agents)'}
    </label>
  );
}
