// The side panel's decision logic: which page, step, form and unit an answer or an agent edit
// belongs to, and what a fill leaves alone because of it. No DOM: the views draw what it decides.
// One part of the panel; sidepanel.js wires the parts together.
import { state } from './core.js';

// The step a tab of a one-address application (AmWINS, GEICO) is on, as the panel last heard it
// (noteStep, renderReport); undefined for carriers whose pages have their own addresses. It can lag
// the page by a message: callers that have the step the page itself named pass that instead.
function tabStep(carrier = state.tab?.carrier, tabId = state.tab?.id) {
  return carrier?.layoutSteps ? state.tabSteps?.get(tabId) : undefined;
}

// On a one-address application, a step about one vehicle or driver (GEICO's Vehicles, Drivers &
// Incidents: `vehicleSteps`, `driverSteps`) is scoped like Progressive's Add Vehicle and Add Driver.
function stepScope(page, carrier = state.tab?.carrier, active = state.active, step = tabStep(carrier)) {
  const entity = carrier?.vehiclePages?.includes(page) || (step && carrier?.vehicleSteps?.includes(step)) ? `v${active.vehicles ?? 0}`
    : carrier?.trailerPages?.includes(page) ? `tr${active.trailers ?? 0}`
      : (carrier?.driverPage && carrier.driverPage === page) || (step && carrier?.driverSteps?.includes(step)) ? `d${active.drivers ?? 0}` : '';
  return `${page}|${entity}|`;
}

// Agent edits are protected per page, and on a page about one vehicle or driver per that vehicle
// or driver (the scope of stepScope): correcting the first vehicle's value on Add Vehicle doesn't
// leave the next vehicle's box alone. `step`: the step the page named, when the caller has it.
// Where one address holds every step and unit form (formScoped: GEICO), whose steps and forms
// share field names (the owner's and each driver's name, the business's and each vehicle's ZIP):
// per step (`|s:<step>`), and on a unit step per form, the one the tab's latest fill ended on
// there (unitShown): its own while held as maybe another unit's (`|f:<id>`), else its unit's
// (`|v<i>`, `|tr<j>`, `|d<k>`); with none there (the owner check, the owner's driver form), the
// step's (`|s:<step>`, as changeScopes); before a fill read the step, the step's unit. No step
// known: the page.
// `active`, `shown`: those of the fill's tab (rememberFill).
function editScope(page, carrier = state.tab?.carrier, step = tabStep(carrier), { active = state.active, shown = state.unitShown } = {}) {
  if (formScoped(carrier)) {
    if (!step) return page;
    const list = carrier.vehicleSteps?.includes(step) ? 'vehicles' : carrier.driverSteps?.includes(step) ? 'drivers' : null;
    if (!list) return `${page}|s:${step}`;
    const here = shown?.step === step ? shown : null;
    if (here?.held) return `${page}|f:${here.id}`;
    if (here && !here.list) return `${page}|s:${step}`;
    const unit = here?.list ?? list;
    return `${page}|${{ vehicles: 'v', trailers: 'tr', drivers: 'd' }[unit]}${active?.[unit] ?? 0}`;
  }
  const scope = stepScope(page, carrier, state.active, step);
  return scope.endsWith('||') ? page : scope.slice(0, -1);
}

// One address for every step and every vehicle's, trailer's and driver's form (GEICO: its
// vehicleSteps and driverSteps): the agent's edits are kept per step and form (editScope).
function formScoped(carrier) {
  return !!(carrier?.vehicleSteps?.length || carrier?.driverSteps?.length);
}

// One vehicle's (trailer's, driver's) edits on a one-address application: `|v<i>`, `|tr<j>`, `|d<k>`.
function unitScope(page, list, index) {
  return `${page}|${{ vehicles: 'v', trailers: 'tr', drivers: 'd' }[list]}${index ?? 0}`;
}

// Where the agent's changes on the page are filed (the recorder's field_changes). Where one address
// holds every step and form (formScoped), on a unit step by the unit forms the recorder saw on
// screen with them (`forms`: [{ list, id }], pagekit unitFormsNow): each form's own (`|f:<id>`),
// and its unit's too unless the kit would hold it as maybe another unit's (bound to another, or new
// while the active unit was filled on another: pagekit unitFormsOf, against the tab's unitForms).
// None on screen (GEICO's owner check under Vehicles, a list): the step's. Forms not known (no fill
// in that document has named them): the tab's latest form (editScope). Elsewhere one scope, as
// editScope files it (Progressive and AmWINS as before). Element names only.
function changeScopes(page, carrier = state.tab?.carrier, step = tabStep(carrier), forms = null, { active = state.active, bound = state.unitForms } = {}) {
  if (!formScoped(carrier)) return [editScope(page, carrier, step)];
  if (!step) return [page];
  const list = carrier.vehicleSteps?.includes(step) ? 'vehicles' : carrier.driverSteps?.includes(step) ? 'drivers' : null;
  if (!list) return [`${page}|s:${step}`];
  if (!Array.isArray(forms)) return [editScope(page, carrier, step, { active })];
  const shown = forms.filter((u) => ['vehicles', 'drivers', 'trailers'].includes(u?.list) && typeof u.id === 'string' && u.id);
  if (!shown.length) return [`${page}|s:${step}`];
  const scopes = new Set();
  for (const { list: unit, id } of shown) {
    const forUnit = bound?.[unit] ?? {};
    const index = active?.[unit] ?? 0;
    const boundTo = Object.hasOwn(forUnit, id) ? forUnit[id] : null;
    const activeForm = Object.keys(forUnit).find((k) => forUnit[k] === index) ?? null;
    const held = (boundTo != null && boundTo !== index) || (boundTo == null && activeForm != null && activeForm !== id);
    scopes.add(`${page}|f:${id}`);
    if (!held) scopes.add(unitScope(page, unit, index));
  }
  return [...scopes];
}

// The agent's keys a fill leaves alone wherever it is: its edit scope's. Where one address holds
// every step and form (formScoped), only the page's own (edits made where no step was read): the
// kit leaves each step's and form's alone as it reads them on screen (fillSkipBy).
function fillSkip(agentKeys, scope, page, carrier) {
  return [...(agentKeys?.get(formScoped(carrier) ? page : scope) ?? [])];
}

// Where one address holds every step and form (formScoped), the agent's edits by where they were
// made, for the kit to leave alone on that step or form only (pagekit skipBy): per step (`|s:`),
// the active units' (the plan's vehicle, trailer and driver), per form (`|f:`), and which steps are
// about a vehicle or a driver. Null for other carriers. Keys and element names only.
function fillSkipBy(agentKeys, page, carrier, active = state.active) {
  if (!formScoped(carrier)) return null;
  const keysOf = (scope) => [...(agentKeys?.get(scope) ?? [])];
  const steps = {}, forms = {};
  for (const [scope, keys] of agentKeys ?? []) {
    const rest = String(scope).startsWith(`${page}|`) ? String(scope).slice(page.length + 1) : '';
    if (rest.startsWith('s:')) steps[rest.slice(2)] = [...keys];
    if (rest.startsWith('f:')) forms[rest.slice(2)] = [...keys];
  }
  return {
    steps,
    units: { vehicles: keysOf(`${page}|v${active?.vehicles ?? 0}`), trailers: keysOf(`${page}|tr${active?.trailers ?? 0}`), drivers: keysOf(`${page}|d${active?.drivers ?? 0}`) },
    forms,
    stepUnits: Object.fromEntries([...(carrier.vehicleSteps ?? []).map((s) => [s, 'vehicles']), ...(carrier.driverSteps ?? []).map((s) => [s, 'drivers'])]),
  };
}

// Whether the agent settled this field on the page. A row key (name#<row>, field-key v3) is also
// settled by its plain name, saved by an older build, which could have been any row's edit.
function agentEdited(page, key) {
  const keys = state.agentKeys.get(editScope(page));
  return !!keys && (keys.has(key) || keys.has(String(key ?? '').match(/^(.+)#\d+$/)?.[1]));
}

// `active`: the vehicle, driver and trailer the fill's plan is for (fillContext), which the agent's
// picker may have left since. `unitsListed`: the unit list on screen holds every intake unit
// (pickUnitToAdd), so its Looks Good may be clicked (advanceFor).
/** @type {(carrier: CarrierConfig, extra?: FillOptions, autoAdvance?: boolean, active?: object, unitsListed?: boolean) => FillOptions} */

function unitNameFor(carrier, page, active, record) {
  const spec = (carrier?.unitNames ?? []).find((s) => s.page === page);
  if (!spec || !record) return null;
  const units = record[spec.list] ?? [];
  const words = (d) => [d?.first, d?.last].flatMap((n) => String(n ?? '').toUpperCase().split(/[^A-Z0-9]+/)).filter((w) => w.length >= 2);
  const i = active?.[spec.list] ?? 0;
  return { list: spec.list, text: spec.text, names: units.map(words), active: i, label: [units[i]?.first, units[i]?.last].filter(Boolean).join(' ') || 'the selected driver' };
}

export { agentEdited, changeScopes, editScope, fillSkip, fillSkipBy, formScoped, stepScope, tabStep, unitNameFor, unitScope };
