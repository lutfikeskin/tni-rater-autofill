// The quoting history warehouse: TNI's quotes as tables for SQL, in a DuckDB file on the
// maintainer's computer (docs/quoting-history-database.md). Built from the usage log with the
// reviews' own definitions, so it counts what the weekly review counts: what a quote is
// (quoteSessions), a test run (testSessionsOf), how a quote ended on a carrier (quoteOutcomes) and
// each question's final answer (finalAnswers). The log stays the source of record: each run builds
// the whole file again from it (scripts/warehouse.mjs). warehouseRows is the step from events to
// rows; writeWarehouse writes them.

import { quoteSessions } from './events.mjs';
import { quoteOutcomes, testSessionsOf } from './signals.mjs';
import { finalAnswers } from './learn.mjs';

// The intake profile's single values as quote columns: [column, group, key, type, comment]. Its lists
// (vehicles, trailers, drivers, prior insurance) are tables of their own. The groups and keys are
// PROFILE in server/index.mjs; the comments the intake's labels (src/schema.js).
const PROFILE_COLUMNS = [
  ['dot', 'business', 'dot', 'VARCHAR', 'USDOT number: given (a valid number), other (something else written, such as Pending) or blank; never the number'],
  ['mc', 'business', 'mc', 'VARCHAR', 'MC number: given, other or blank'],
  ['fein', 'business', 'fein', 'VARCHAR', 'FEIN: given, other or blank'],
  ['dot_within_60_days', 'business', 'dotWithin60Days', 'BOOLEAN', 'No DOT/MC: will have one within 60 days'],
  ['years_in_business', 'business', 'yearsInBusiness', 'INTEGER', null],
  ['years_experience', 'business', 'yearsExperience', 'INTEGER', 'Years under its own authority'],
  ['owner_drives', 'business', 'ownerDrives', 'BOOLEAN', null],
  ['what_haul', 'operations', 'whatHaul', 'VARCHAR', 'What they haul, as written after cleaning'],
  ['radius_miles', 'operations', 'radiusMiles', 'INTEGER', null],
  ['vehicle_ownership', 'operations', 'vehicleOwnership', 'VARCHAR', null],
  ['personal_use', 'operations', 'personalUse', 'BOOLEAN', 'Vehicle for personal use'],
  ['uses_eld', 'operations', 'usesEld', 'BOOLEAN', null],
  ['eld_brand', 'operations', 'eldBrand', 'VARCHAR', null],
  ['needs_sr22', 'operations', 'needSr22', 'BOOLEAN', null],
  ['filings_required', 'operations', 'filingsRequired', 'BOOLEAN', 'Needs federal or state filings'],
  ['filings_which', 'operations', 'filingsWhich', 'VARCHAR', null],
  ['hazmat', 'operations', 'hazmat', 'BOOLEAN', 'Hazmat, tobacco or Rx'],
  ['haz_placard', 'operations', 'hazPlacard', 'BOOLEAN', null],
  ['moving_state', 'operations', 'movingState', 'BOOLEAN', 'Moving states within 6 months'],
  ['team_driving', 'operations', 'teamDriving', 'BOOLEAN', 'Team driving or slip seating'],
  ['canada_loads', 'operations', 'canadaLoads', 'BOOLEAN', null],
  ['equip_vehicle', 'operations', 'equipVehicle', 'INTEGER', 'Attached equipment value on the vehicles, dollars'],
  ['trailer_ownership', 'trailerInfo', 'ownership', 'VARCHAR', null],
  ['trailer_hitch', 'trailerInfo', 'hitch', 'VARCHAR', null],
  ['trailer_interchange', 'trailerInfo', 'interchange', 'BOOLEAN', 'Trailer interchange needed'],
  ['trailer_interchange_limit', 'trailerInfo', 'interchangeLimit', 'INTEGER', 'Dollars'],
  ['equip_trailer', 'trailerInfo', 'equipTrailer', 'INTEGER', 'Attached equipment value on the trailers, dollars'],
  ['auto_liability', 'coverage', 'autoLiability', 'VARCHAR', null],
  ['auto_liab_limit', 'coverage', 'autoLiabLimit', 'VARCHAR', 'As written: $1M CSL, 25/50/25, State Minimum'],
  ['cargo', 'coverage', 'cargo', 'BOOLEAN', null],
  ['cargo_limit', 'coverage', 'cargoLimit', 'INTEGER', 'Dollars'],
  ['cargo_deductible', 'coverage', 'cargoDeductible', 'INTEGER', 'Dollars'],
  ['gl', 'coverage', 'gl', 'BOOLEAN', 'General liability requested'],
  ['has_gl', 'coverage', 'hasGl', 'BOOLEAN', 'Already has general liability'],
  ['gl_limit', 'coverage', 'glLimit', 'VARCHAR', 'As written'],
  ['reefer_breakdown', 'coverage', 'reeferBreakdown', 'BOOLEAN', null],
  ['ntl', 'coverage', 'ntl', 'BOOLEAN', 'Non-trucking liability'],
];
const UNIT_COLUMNS = [['type', 'VARCHAR'], ['year', 'INTEGER'], ['make', 'VARCHAR'], ['model', 'VARCHAR'], ['value', 'INTEGER', 'Dollars']];

// Every table: its comment, columns ([name, type, comment]) and primary key. A yes/no column is
// null when the intake left it unanswered, never No.
export const TABLES = {
  events: {
    comment: 'Every event the usage log holds, once per id, as stored: test runs, the local test page and blank pages too',
    columns: [
      ['id', 'VARCHAR'], ['t', 'TIMESTAMPTZ', "Logged, by the agent's computer clock"], ['received_at', 'TIMESTAMPTZ', 'Stored by the usage server'],
      ['type', 'VARCHAR'], ['session', 'VARCHAR', 'One intake loaded in the panel'], ['intake_id', 'VARCHAR', 'SHA-256 of the intake PDF'],
      ['carrier', 'VARCHAR'], ['page', 'VARCHAR'], ['agent', 'VARCHAR', "The agent's initials"], ['install', 'VARCHAR'], ['version', 'VARCHAR'],
      ['body', 'JSON', 'The event as stored'],
    ],
    key: [],
  },
  quotes: {
    comment: "One row per quote: an intake loaded in a session that worked on a carrier's page. Profile columns come from the session's last intake_profile, null on quotes without one. v_quotes leaves out test runs",
    columns: [
      ['session', 'VARCHAR'], ['intake_id', 'VARCHAR', 'SHA-256 of the intake PDF: a client quoted twice from one PDF has one'],
      ['agent', 'VARCHAR'], ['install', 'VARCHAR'], ['started_at', 'TIMESTAMPTZ', 'The intake was loaded'], ['last_at', 'TIMESTAMPTZ', "The quote's last event"],
      ['version', 'VARCHAR', "The extension's version"], ['channel', 'VARCHAR'], ['is_test', 'BOOLEAN', "Marked as a test, listed in the test-run list, or one of the repository's fixture PDFs"],
      ['profile_source', 'VARCHAR', 'event: an intake_profile was logged; null: only the summary logged on load'],
      ['profile_dropped', 'VARCHAR[]', 'Fields the usage server left out of that profile event as out of shape'],
      ['state', 'VARCHAR', 'Garaging state: the profile, else the summary logged on load'],
      ['business_class', 'VARCHAR', 'The profile, else the summary logged on load'],
      ...PROFILE_COLUMNS.map(([c, , , type, comment]) => [c, type, comment]),
      ['has_claims', 'BOOLEAN', 'Any claims or violations in the last 36 months'],
      ['vehicle_types', 'VARCHAR[]', 'Distinct vehicle types: the profile, else the summary logged on load'],
      ['drivers', 'INTEGER'], ['vehicles', 'INTEGER'], ['trailers', 'INTEGER'],
      ['requested', 'VARCHAR[]', 'Coverages the intake answers Yes, as logged on load (intake_loaded.coverages)'],
      ['profile', 'JSON', 'The whole profile as logged'],
    ],
    key: ['session'],
  },
  quote_vehicles: {
    comment: 'One row per vehicle or trailer on the intake profile (at most 50 of each per quote)',
    columns: [['session', 'VARCHAR'], ['kind', 'VARCHAR', 'vehicle or trailer'], ['n', 'INTEGER', 'Its order on the intake'], ...UNIT_COLUMNS],
    key: ['session', 'kind', 'n'],
  },
  quote_drivers: {
    comment: 'One row per driver on the intake profile',
    columns: [
      ['session', 'VARCHAR'], ['n', 'INTEGER'], ['age', 'INTEGER', 'On the day the profile was built, from the date of birth (not kept)'],
      ['license_state', 'VARCHAR'], ['cdl', 'BOOLEAN'], ['cdl_year', 'INTEGER'], ['excluded', 'BOOLEAN', 'Marked excluded on the intake'],
      ['marital_status', 'VARCHAR', "The intake's answer"],
      ['gender', 'VARCHAR', "MALE or FEMALE as the agent set it in the panel; null: not set, so the carriers got Male (TNI's standard)"],
    ],
    key: ['session', 'n'],
  },
  quote_prior_insurance: {
    comment: 'One row per prior policy on the intake profile',
    columns: [['session', 'VARCHAR'], ['n', 'INTEGER'], ['type', 'VARCHAR'], ['insurer', 'VARCHAR'], ['policy_limit', 'VARCHAR', 'As written'], ['expires', 'VARCHAR', 'YYYY-MM, or none (no prior insurance)']],
    key: ['session', 'n'],
  },
  quote_carriers: {
    comment: 'One row per quote and carrier it was worked on (quoteOutcomes, as the weekly review counts)',
    columns: [
      ['session', 'VARCHAR'], ['carrier', 'VARCHAR'], ['first_at', 'TIMESTAMPTZ'], ['last_at', 'TIMESTAMPTZ'],
      ['last_page', 'VARCHAR', 'Page, or "page › step" on one-address carriers (AmWINS, GEICO)'],
      ['outcome', 'VARCHAR', 'done, declined or stopped (on last_page)'],
      ['done', 'BOOLEAN', "Reached the carrier's final page, or printed, after this quote's own fill there"],
      ['declined', 'BOOLEAN', "A stop on a page that isn't final: the carrier's refusal"],
      ['logins', 'INTEGER', "Times the carrier's login came up mid-quote"],
    ],
    key: ['session', 'carrier'],
  },
  answers: {
    comment: "One row per question and unit a quote answered on a carrier: its final answer (finalAnswers). Typed text isn't logged, so its value is null",
    columns: [
      ['session', 'VARCHAR'], ['carrier', 'VARCHAR'],
      ['question', 'VARCHAR', "The learner's key: carrier|page|ref:<name>, or its text on its page"],
      ['unit', 'VARCHAR', "Which vehicle, driver or trailer, and row; '' for the quote"],
      ['page', 'VARCHAR'], ['step', 'VARCHAR'], ['label', 'VARCHAR', 'The question as logged (redacted)'], ['control_kind', 'VARCHAR'],
      ['value', 'VARCHAR', 'The option picked'],
      ['answered_by', 'VARCHAR', "autofill, agent, or page (the page's own answer left standing)"],
      ['rule_source', 'VARCHAR', "Where autofill's answer came from: intake, derived, standard (TNI's), fact, attestation"],
      ['intake_path', 'VARCHAR', 'The intake field the rule used'],
      ['corrected', 'BOOLEAN', 'The agent changed an autofilled answer'],
      ['left_to_agent', 'BOOLEAN', 'No rule knew the question, or a required one autofill could not answer'],
      ['matches_intake', 'VARCHAR[]', "Intake fields a typed value matched (the value itself isn't logged)"],
    ],
    key: ['session', 'question', 'unit'],
  },
  build_info: {
    comment: 'The run that built this file',
    columns: [
      ['built_at', 'TIMESTAMPTZ'], ['commit', 'VARCHAR', 'The commit whose definitions built the tables'], ['dirty', 'BOOLEAN', 'That checkout had uncommitted changes'],
      ['sources', 'VARCHAR[]', 'The folders and files read'], ['events', 'INTEGER', 'Events stored'], ['quotes', 'INTEGER'], ['test_quotes', 'INTEGER'],
      ['test_list', 'VARCHAR', 'The test-run list read'], ['first_event', 'TIMESTAMPTZ'], ['last_event', 'TIMESTAMPTZ'],
    ],
    key: [],
  },
};

export const VIEWS = {
  v_quotes: { comment: 'The quotes, without test runs: start here', sql: 'SELECT * FROM quotes WHERE NOT is_test' },
};

const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The statements that create the tables, views and their comments, in order.
export function schemaSql() {
  const out = [];
  for (const [name, { comment, columns, key }] of Object.entries(TABLES)) {
    const cols = columns.map(([c, type]) => `${c} ${type}`);
    if (key.length) cols.push(`PRIMARY KEY (${key.join(', ')})`);
    out.push(`CREATE TABLE ${name} (${cols.join(', ')})`);
    out.push(`COMMENT ON TABLE ${name} IS ${sqlString(comment)}`);
    for (const [c, , note] of columns) if (note) out.push(`COMMENT ON COLUMN ${name}.${c} IS ${sqlString(note)}`);
  }
  for (const [name, { comment, sql }] of Object.entries(VIEWS)) {
    out.push(`CREATE VIEW ${name} AS ${sql}`);
    out.push(`COMMENT ON VIEW ${name} IS ${sqlString(comment)}`);
  }
  return out;
}

// Values in their column's type, or null: a local export never checked by the server can't stop a build.
const iso = (v) => {
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const int = (v) => (Number.isSafeInteger(v) && Math.abs(v) <= 2 ** 31 - 1 ? v : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
const strs = (v) => (Array.isArray(v) ? v.map(str).filter((x) => x !== null) : []);
const cast = { VARCHAR: str, INTEGER: int, BOOLEAN: bool };
const group = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : null);
const list = (v) => (Array.isArray(v) ? v.map(group).filter(Boolean) : []);
const PROFILE_UNITS = 50; // the most units a profile list holds (PROFILE_UNITS in server/index.mjs)
const PROFILE_GROUPS = ['business', 'operations', 'vehicles', 'trailers', 'trailerInfo', 'drivers', 'coverage', 'priorInsurance', 'hasClaims'];

/** The events table: every stored event (readEvents), once per id. */
export function eventRows(stored) {
  return stored.map((e) => ({
    id: str(e.id), t: iso(e.t), received_at: iso(e.receivedAt), type: str(e.type), session: str(e.session), intake_id: str(e.intakeId),
    carrier: str(e.carrier), page: str(e.page), agent: str(e.agent), install: str(e.install), version: str(e.v), body: JSON.stringify(e),
  }));
}

/**
 * The derived tables' rows, from the events the reviews read.
 * @param {object[]} events  loadEvents(): in time order, test page and blank pages left out
 * @param {{testIntakes?: Iterable<string>}} opts  the test-run list (readTestList().intakes)
 * @returns {{quotes: object[], quote_vehicles: object[], quote_drivers: object[], quote_prior_insurance: object[], quote_carriers: object[], answers: object[]}}
 */
export function warehouseRows(events, { testIntakes = [] } = {}) {
  const quoted = quoteSessions(events);
  const tests = testSessionsOf(events, testIntakes);
  const loaded = new Map();
  const profiles = new Map();
  const lastAt = new Map();
  for (const e of events) {
    if (!quoted.has(e.session)) continue;
    lastAt.set(e.session, e.t);
    if (e.type === 'intake_loaded' && !loaded.has(e.session)) loaded.set(e.session, e);
    // The last one: it holds the agent's corrections.
    if (e.type === 'intake_profile') profiles.set(e.session, e);
  }

  const rows = { quotes: [], quote_vehicles: [], quote_drivers: [], quote_prior_insurance: [], quote_carriers: [], answers: [] };
  for (const [session, l] of loaded) {
    const p = profiles.get(session) ?? null;
    // A profile value when the profile has it (a group the server dropped doesn't), else `fallback`.
    const from = (g, k, fallback = null) => (group(p?.[g]) && Object.hasOwn(p[g], k) ? p[g][k] : fallback);
    // The profile's count, as corrected; the load's when the profile stopped at its 50 units.
    const units = (g, k) => {
      const counted = int(l.counts?.[k]);
      if (!Array.isArray(p?.[g])) return counted;
      return p[g].length >= PROFILE_UNITS && counted > p[g].length ? counted : p[g].length;
    };
    const vehicles = list(p?.vehicles);
    rows.quotes.push({
      session, intake_id: str(l.intakeId), agent: str(l.agent), install: str(l.install), started_at: iso(l.t), last_at: iso(lastAt.get(session)),
      version: str(l.v), channel: str(l.channel), is_test: tests.has(session),
      profile_source: p ? 'event' : null, profile_dropped: p ? strs(p.dropped) : null,
      state: str(from('business', 'state', l.state)), business_class: str(from('business', 'businessClass', l.businessClass)),
      ...Object.fromEntries(PROFILE_COLUMNS.map(([c, g, k, type]) => [c, cast[type](from(g, k))])),
      vehicle_types: Array.isArray(p?.vehicles) ? [...new Set(strs(vehicles.map((v) => v.type)))] : strs(l.vehicleTypes),
      drivers: units('drivers', 'drivers'), vehicles: units('vehicles', 'vehicles'), trailers: units('trailers', 'trailers'),
      requested: strs(l.coverages),
      has_claims: p ? bool(p.hasClaims) : null,
      profile: p ? Object.fromEntries(PROFILE_GROUPS.filter((g) => Object.hasOwn(p, g)).map((g) => [g, p[g]])) : null,
    });
    for (const kind of ['vehicle', 'trailer']) {
      list(p?.[`${kind}s`]).forEach((u, i) => rows.quote_vehicles.push({ session, kind, n: i + 1, type: str(u.type), year: int(u.year), make: str(u.make), model: str(u.model), value: int(u.value) }));
    }
    list(p?.drivers).forEach((d, i) => rows.quote_drivers.push({
      session, n: i + 1, age: int(d.age), license_state: str(d.licenseState), cdl: bool(d.cdl), cdl_year: int(d.cdlYear),
      excluded: bool(d.excluded), marital_status: str(d.maritalStatus), gender: str(d.gender),
    }));
    list(p?.priorInsurance).forEach((x, i) => rows.quote_prior_insurance.push({
      session, n: i + 1, type: str(x.type), insurer: str(x.carrier), policy_limit: str(x.limit), expires: str(x.expires),
    }));
  }

  for (const q of quoteOutcomes(events, quoted)) {
    rows.quote_carriers.push({
      session: q.session, carrier: q.carrier, first_at: iso(q.first), last_at: iso(q.last), last_page: q.lastPage,
      // As the weekly numbers read it: done first, then declined.
      outcome: q.done ? 'done' : q.declined ? 'declined' : 'stopped', done: q.done, declined: q.declined, logins: q.logins,
    });
  }

  for (const [session, perSession] of finalAnswers(events)) {
    if (!quoted.has(session)) continue;
    for (const [k, a] of perSession) {
      rows.answers.push({
        session, carrier: a.carrier, question: a.question, unit: k.slice(a.question.length + 1), page: str(a.page), step: str(a.step),
        label: str(a.label), control_kind: str(a.kind), value: str(a.value), answered_by: str(a.source), rule_source: str(a.ruleSource),
        intake_path: str(a.mappedPath), corrected: !!a.corrected, left_to_agent: !!a.leftToAgent, matches_intake: Array.isArray(a.matches) ? strs(a.matches) : null,
      });
    }
  }
  return rows;
}

/**
 * Writes a new DuckDB file: the schema, then every table's rows. The file must not exist yet
 * (scripts/warehouse.mjs builds beside the old one and swaps them).
 * @param {string} file
 * @param {Record<string, object[]>} tables  rows by table name (TABLES), each row by column name
 */
export async function writeWarehouse(file, tables) {
  const { DuckDBInstance, DuckDBTypeId } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(file);
  const db = await instance.connect();
  try {
    for (const sql of schemaSql()) await db.run(sql);
    for (const [name, rows] of Object.entries(tables)) {
      const { columns } = TABLES[name];
      const appender = await db.createAppender(name);
      const types = columns.map((_, i) => appender.columnType(i));
      for (const row of rows) {
        columns.forEach(([c], i) => {
          const v = row[c];
          if (v === null || v === undefined) appender.appendNull();
          else if (types[i].typeId === DuckDBTypeId.BOOLEAN) appender.appendBoolean(v);
          else if (types[i].typeId === DuckDBTypeId.INTEGER) appender.appendInteger(v);
          else if (types[i].typeId === DuckDBTypeId.LIST) appender.appendList(v, types[i]);
          // VARCHAR and JSON as text; TIMESTAMPTZ from its ISO text.
          else appender.appendVarchar(typeof v === 'string' ? v : JSON.stringify(v));
        });
        appender.endRow();
      }
      appender.closeSync();
    }
    await db.run('CHECKPOINT');
  } finally {
    db.closeSync();
    instance.closeSync();
  }
}
