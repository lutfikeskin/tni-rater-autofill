// Settings → TNI defaults (docs/agent-defaults-spec.md, "TNI defaults (basic)"): the agent's own
// amounts in place of TNI's standards, kept in a profile the agent picks, never under their initials
// alone. Drawn from the store's `agentDefaults` (store.js) and `defaultsInitials`; what its controls do
// is `act.defaults` (store.js defaultsActs). Hidden while the feature is off (AGENT_DEFAULTS_ON).
import { useState } from 'react';
import { useStore } from 'zustand';
import { panelStore } from '../state-store.js';
import { AGENT_DEFAULTS_ON, REGISTRY, amountSaid } from '../../../src/agent-defaults/index.js';
import { STANDARD_IDS } from '../../../src/standards.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One standard's row: TNI's amount first, then every amount all carriers sell.
function DefaultRow({ entry, value, onPick }) {
  const tni = STANDARD_IDS[entry.id]();
  const choices = entry.choices.all.filter((c) => !same(c, tni));
  const index = value == null ? -1 : choices.findIndex((c) => same(c, value));
  const id = `default-${entry.id}`;
  return (
    <label className="opt" htmlFor={id}>
      <span className="opt-text"><b>{entry.label}</b>{index >= 0 ? <span className="small-note">{`TNI's: ${amountSaid(tni)}`}</span> : null}</span>
      <select id={id} value={String(index)} onChange={(e) => { const i = Number(e.target.value); onPick(i >= 0 ? choices[i] : null); }}>
        <option value="-1">{`TNI's (${amountSaid(tni)})`}</option>
        {choices.map((c, i) => <option key={i} value={String(i)}>{amountSaid(c)}</option>)}
      </select>
    </label>
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
      <div className="card padded">
        <p className="fine">{'Your own amounts in place of TNI\'s standards. Each quote asks before using them; client requests on the intake always come first.'}</p>
        {!initials ? <p className="fine" role="status">Set your initials above to use your own defaults.</p> : (
          <>
            <label className="opt" htmlFor="defaults-profile">
              <span className="opt-text"><b>Profile</b></span>
              <select id="defaults-profile" value={stored?.active ?? ''} onChange={(e) => act.pick(e.target.value || null)}>
                <option value="">{'None: TNI\'s everywhere'}</option>
                {profiles.map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
              </select>
            </label>
            {naming ? (
              <div className="row-actions">
                <input id="defaults-new-name" type="text" maxLength={40} autoComplete="off" placeholder="Your name, e.g. Jordan K." value={name}
                  onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
                <button type="button" className="primary small-btn" disabled={!name.trim()} onClick={create}>Create</button>
                <button type="button" className="ghost small-btn" onClick={() => setNaming(false)}>Cancel</button>
              </div>
            ) : (
              <div className="row-actions">
                <button type="button" id="defaults-new" className="ghost small-btn" onClick={() => setNaming(true)}>New profile</button>
                {active ? <button type="button" id="defaults-delete" className="ghost small-btn" onClick={() => { if (confirm(`Delete ${active.name}'s defaults?`)) act.remove(stored.active); }}>Delete profile</button> : null}
              </div>
            )}
            {active ? REGISTRY.filter((e) => !e.locked).map((entry) => (
              <DefaultRow key={entry.id} entry={entry} value={active.values?.[entry.id]?.value ?? null} onPick={(v) => act.set(entry.id, v)} />
            )) : null}
          </>
        )}
      </div>
    </div>
  );
}
