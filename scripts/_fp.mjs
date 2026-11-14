import crypto from 'node:crypto';
import { EVENT_FIELDS, COMMON, PROFILE } from '../server/index.mjs';
const profileShape = (spec) => (typeof spec === 'function' ? true : Array.isArray(spec) ? [profileShape(spec[0])]
  : Object.fromEntries(Object.keys(spec).sort().map((k) => [k, profileShape(spec[k])])));
console.log(crypto.createHash('sha256').update(JSON.stringify({
  common: COMMON, events: Object.keys(EVENT_FIELDS).sort().map((t) => [t, EVENT_FIELDS[t]]), profile: profileShape(PROFILE),
})).digest('hex').slice(0, 12));
