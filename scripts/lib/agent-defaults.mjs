// Agents' own defaults in the review tooling (docs/agent-defaults-spec.md, "Logging and review"): the
// one script that imports the module (src/agent-defaults/). The benchmark and the answer key replay
// each quote with the defaults it logged, so an agent's own default never reads as "today's rules
// differ"; the weekly signals and the rule suggestions keep answers filled with an agent's default
// apart from TNI's rules. Removing the feature: delete this file and its uses (each marked
// "agent defaults").

import { AGENT_DEFAULT_SOURCE, amountSaid, profileFromLog, replayOverlay } from '../../src/agent-defaults/index.js';
import { entryOf } from '../../src/agent-defaults/registry.js';

export { AGENT_DEFAULT_SOURCE };

// An answer filled with the agent's own default, by its logged or replayed source.
export const isOwnDefault = (source) => source === AGENT_DEFAULT_SOURCE;

// session -> the defaults its last agent_settings logged (the list a quote was filled with; an empty
// list: TNI's everywhere).
export function sessionDefaults(events) {
  const out = new Map();
  for (const e of events) if (e.type === 'agent_settings' && e.session && Array.isArray(e.defaults)) out.set(e.session, e.defaults);
  return out;
}

// The step overlay that replays one quote's defaults on a carrier (null: TNI's), made once per
// session and carrier.
export function replayer(events) {
  const logged = sessionDefaults(events);
  const made = new Map();
  return (session, carrierId) => {
    const k = `${session}|${carrierId}`;
    if (!made.has(k)) made.set(k, replayOverlay(logged.get(session), carrierId));
    return made.get(k);
  };
}

// How a logged default reads in a report: "Medical payments: $2,000", "Uninsured / underinsured
// motorist (CSL) (geico): Ask me"; null for one the registry no longer has.
export function defaultSaid(d) {
  const profile = profileFromLog([d]);
  const pick = d.carrier ? profile?.carriers[d.carrier]?.[d.id] : profile?.values[d.id];
  if (!pick) return null;
  const label = entryOf(d.id)?.label ?? d.id;
  return `${label}${d.carrier ? ` (${d.carrier})` : ''}: ${'ask' in pick ? 'Ask me' : amountSaid(pick.value)}`;
}

// The defaults in force on the given quotes: each default, by the quotes and agents that had it.
export function defaultsInForce(events, sessions) {
  const logged = sessionDefaults(events);
  const agentOf = new Map(events.filter((e) => e.session && e.agent).map((e) => [e.session, e.agent]));
  const out = new Map();
  let quotes = 0;
  for (const [session, list] of logged) {
    if (!sessions.has(session)) continue;
    quotes++;
    for (const d of list) {
      const text = defaultSaid(d);
      if (!text) continue;
      const x = out.get(text) ?? { text, quotes: new Set(), agents: new Set() };
      x.quotes.add(session);
      if (agentOf.get(session)) x.agents.add(agentOf.get(session));
      out.set(text, x);
    }
  }
  return {
    quotes,
    defaults: [...out.values()].map((x) => ({ text: x.text, quotes: x.quotes.size, agents: [...x.agents].sort() })).sort((a, b) => b.quotes - a.quotes || a.text.localeCompare(b.text)),
  };
}
