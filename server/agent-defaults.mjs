// Agents' own defaults (docs/agent-defaults-spec.md): everything the collection server knows about
// them, kept in this one module. index.mjs only plugs these exports in, at the places marked
// "agent defaults" there.
//
// Removing the feature from the server: delete this file, its import and those marked lines in
// index.mjs, its name in server/Dockerfile's COPY and in SERVER_HASH, and the "agent defaults"
// tests in test/server.test.mjs and test/consistency.test.mjs. Events already stored keep their
// fields; a server without this module drops them from new events and names them in `dropped`.

// A filled answer's source when the agent's own default replaced a TNI standard.
export const AGENT_DEFAULT_SOURCE = 'agent-default';

// The fields each event type keeps for agent defaults. agent_settings.defaults: the TNI standards
// the agent replaced (DEFAULTS_SHAPE). defaultsHash: the fingerprint of the defaults a fill ran
// with (none: TNI's), on its fill_run, and on its fill_error when it failed.
export const AGENT_DEFAULT_FIELDS = {
  agent_settings: ['defaults'],
  fill_run: ['defaultsHash'],
  fill_error: ['defaultsHash'],
};

// Run-identity fields: a malformed one refuses the whole event, like the rules fingerprint.
export const AGENT_DEFAULT_RUN_FIELDS = {
  defaultsHash: (v) => typeof v === 'string' && /^[0-9a-f]{6,16}$/.test(v),
};

// agent_settings.defaults: each TNI standard the agent replaced, as { id, value, carrier? }. The
// id is the standard's (medPay, umCsl); the carrier is given only for an Advanced default kept to
// one carrier; the value is an amount, 'ask' (the agent answers it), or a carrier's option of at
// most 40 characters. These are settings, never client data.
const DEFAULT_KEYS = ['id', 'value', 'carrier'];
const defaultValue = (x) => x === 'ask' || (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100_000_000)
  || (typeof x === 'string' && /^[\w $,./&+-]{1,40}$/.test(x));
export const DEFAULTS_SHAPE = (v) => Array.isArray(v) && v.length <= 40 && v.every((d) => !!d && typeof d === 'object' && !Array.isArray(d)
  && Object.keys(d).every((k) => DEFAULT_KEYS.includes(k))
  && typeof d.id === 'string' && /^[a-zA-Z]{1,24}$/.test(d.id) && defaultValue(d.value)
  && (d.carrier === undefined || (typeof d.carrier === 'string' && /^[a-z]{1,20}$/.test(d.carrier))));

// Drops an agent_settings event's defaults when they are not in their shape: the list goes whole,
// so a half-read list never looks like the agent's full settings.
export function cleanAgentDefaults(out, drop) {
  if (out.type === 'agent_settings' && out.defaults !== undefined && !DEFAULTS_SHAPE(out.defaults)) drop('defaults');
}
