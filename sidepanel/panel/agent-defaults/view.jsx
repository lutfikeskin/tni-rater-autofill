// Settings → TNI defaults (docs/agent-defaults-spec.md, "TNI defaults (basic)" and "Advanced"): the
// agent's own amounts in place of TNI's standards, kept in a profile the agent picks, never under their
// initials alone. Advanced, collapsed, gives each carrier its own: an amount only that carrier sells,
// TNI's there, or "Ask me". Drawn from the store's `agentDefaults` (store.js) and `defaultsInitials`; what its controls do
// is `act.defaults` (store.js defaultsActs). Hidden while the feature is off (AGENT_DEFAULTS_ON).
import { useState } from 'react';
import { useStore } from 'zustand';
import { panelStore } from '../state-store.js';
import { AGENT_DEFAULTS_ON, REGISTRY, amountSaid, effectiveDefaults } from '../../../src/agent-defaults/index.js';
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

// What Advanced does, on its row's tooltip: the design system keeps explanations off the list.
const ABOUT_ADVANCED = "A carrier's own amount, or Ask me to answer it yourself on that carrier. Answers that rest on it (PIP beside Medical payments, GEICO's rental beside the deductibles) become yours too.";

// Advanced: a row that opens its card, as AI's does, collapsed until the agent opens it; the row
// says how many carrier picks the profile has. One group per carrier inside.
function Advanced({ profile, act }) {
  const basic = effectiveDefaults({ values: profile.values }, null);
  const picks = Object.values(profile.carriers ?? {}).reduce((n, own) => n + Object.keys(own).length, 0);
  return (
    <details id="defaults-advanced" className="fold">
      <summary className="list-row" title={ABOUT_ADVANCED}><span className="fold-name">Advanced: per carrier</span><span className="fold-note">{picks ? `${picks} carrier ${picks === 1 ? 'pick' : 'picks'}` : 'Same everywhere'}</span><span className="chev" aria-hidden="true">›</span></summary>
      <div className="card">
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

export function TniDefaults({ act }) {
  const stored = useStore(panelStore, (s) => s.agentDefaults);
  const initials = useStore(panelStore, (s) => s.defaultsInitials);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  if (!AGENT_DEFAULTS_ON) return null;
  const profiles = Object.entries(stored?.profiles ?? {});
  const active = stored?.active ? stored.profiles[stored.active] : null;
  const create = () => { act.create(name); setName(''); setNaming(false); };
  return (
    <div className="group" id="tni-defaults">
      <div className="eyebrow">TNI defaults</div>
      <div className="card">
        {!initials ? <p className="fine card-note" role="status">Set your initials above to use your own defaults.</p> : (
          <>
            <label className="opt" htmlFor="defaults-profile">
              <span className="opt-text"><b>Profile</b></span>
              <select id="defaults-profile" value={stored?.active ?? ''} onChange={(e) => act.pick(e.target.value || null)}>
                <option value="">{'None: TNI\'s everywhere'}</option>
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
          </>
        )}
      </div>
      <p className="fine" title="Your own amounts in place of TNI's standards.">Each quote asks first. Client requests on the intake always win.</p>
      {initials && active ? <Advanced profile={active} act={act} /> : null}
    </div>
  );
}
