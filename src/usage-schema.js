// @ts-check
// The usage log's event contract, in one place for the extension and the collection server (audit
// 2026-11-07, SRV-14): which event types there are and which fields each keeps (COMMON,
// EVENT_FIELDS), what the business profile's text may not hold (ID_LIKE, LIMIT, PROFILE_UNITS),
// and the schema's version. The extension stamps SCHEMA_VERSION on every event
// (sidepanel/usage-log.js); the server (server/index.mjs) keeps only these fields, checks their
// shapes itself, and refuses an event of a newer schema than its own, which the extension keeps and
// sends again after the server is deployed, so a field an extension sends before its server knows
// it is never dropped. The server image copies this file (server/Dockerfile), and /v1/health names
// the version (`schema`).
//
// No imports: the server image has only this file of src/.
//
// Changing the contract (an event type, a field, a profile group or field) changes its fingerprint
// (a SHA-256 of COMMON, the server's EVENT_FIELDS and PROFILE's fields): test/consistency.test.mjs
// holds every version's fingerprint and fails until SCHEMA_VERSION is raised and the new version's
// added, so an extension that sends the new fields waits for a server that keeps them.

export const SCHEMA_VERSION = 6;

// Event type -> fields kept. Anything else in an event is dropped (and named in `dropped`).
// install: a random id for one copy of the extension on one computer (with seq: gaps show loss).
// schema: the SCHEMA_VERSION the event was logged under.
export const COMMON = ['id', 't', 'v', 'channel', 'commit', 'agent', 'install', 'session', 'intakeId', 'seq', 'type', 'carrier', 'page', 'view', 'schema'];
/** @type {Record<string, readonly string[]>} */
export const EVENT_FIELDS = {
  // test: the agent marked this intake as a test run before (on this computer).
  // platform: the computer's system and Chrome's major version.
  intake_loaded: ['formVersion', 'answers', 'state', 'businessClass', 'vehicleTypes', 'counts', 'coverages', 'warnings', 'test', 'platform'],
  // What the client's business looks like, never who it is (src/usage.js intakeProfile): when the
  // intake is loaded and after the agent corrects it. Each group is kept in its shape (PROFILE).
  intake_profile: ['business', 'operations', 'vehicles', 'trailers', 'trailerInfo', 'drivers', 'coverage', 'priorInsurance', 'hasClaims'],
  // Events the computer's log dropped (full, oldest first): how many.
  usage_lost: ['count'],
  intake_closed: ['reason'],
  // The agent marked the loaded intake as a test run, or unmarked it.
  intake_marked: ['test'],
  // The agent's settings, all of them each time (values: booleans and where usage goes).
  agent_settings: ['reason', 'changed', 'values'],
  intake_edit: ['path', 'kind', 'change', 'warnings'],
  warning_checked: ['code', 'path', 'checked'],
  page_view: ['from', 'fields'],
  // messages: what the page said about the answers (validation, errors, help), redacted by the panel.
  page_layout: ['context', 'fields', 'buttons', 'reason', 'step', 'messages'],
  // The premium a carrier page quoted (src/premium.js): amounts, the term in months and the payments.
  quote_premium: ['step', 'total', 'termMonths', 'dueToday', 'payments', 'payment'],
  // A page layout the panel couldn't record (why it was asked for, and the error's first words).
  layout_error: ['reason', 'error'],
  // pageChanged: the carrier probably changed the page; reworded: known fields whose question reads
  // differently; renamed: known questions whose data-model name isn't on the page (rule, names).
  // run: one fill invocation, shared with its fill_field events; rules: the rule files'
  // fingerprint; settings: the panel's filling switches; step: a one-address application's step
  // (AmWINS). The server checks their shapes (RUN_FIELDS): a malformed value refuses the event.
  // retried: the second click of a Continue whose page stayed unchanged (true only), on its fill_run or fill_error.
  // background: the quote tab filled while the agent was on another; hiddenMs: how long its page was
  // hidden meanwhile (Chrome slows a hidden tab's timers).
  // waits: the fill's waits by what they were for, counts and ms only (FillRunWaits in types.js; REC-09).
  fill_run: ['run', 'rules', 'settings', 'step', 'overwrite', 'auto', 'background', 'hiddenMs', 'retried', 'waits', 'ms', 'fields', 'rounds', 'filled', 'kept', 'noData', 'failed', 'leftRequired', 'unknown', 'clicked', 'blockers', 'blockerList', 'advanced', 'pageChanged', 'reworded', 'renamed', 'timeline'],
  // how: what found the field (field = data-model name, text, option, selector, label, name).
  // source: where the answer comes from (plan.js; the server's FIELD_SOURCES); standard, manualOnly,
  // review: a TNI standard, the agent's only, a review-mode answer the agent confirms.
  fill_field: ['run', 'step', 'result', 'q', 'key', 'label', 'path', 'controlKind', 'shown', 'code', 'reason', 'options', 'timing', 'how', 'source', 'standard', 'manualOnly', 'review'],
  // A button the agent clicked themselves: its text (60 characters), and the step on screen.
  agent_click: ['text', 'step'],
  // The agent dismissed a "needs you" item (×): the question, and why it needed them.
  check_dismissed: ['q', 'key', 'label', 'mark'],
  fill_error: ['run', 'rules', 'settings', 'auto', 'retried', 'error', 'timeline'],
  field_change: ['step', 'q', 'key', 'label', 'kind', 'by', 'autofilled', 'change', 'vsAutofill', 'matchesIntake', 'from', 'to'],
  // With what it is about: the last fill on that tab and page (run, step, what held Continue, how
  // many seconds before the report).
  problem_report: ['text', 'run', 'step', 'blockerList', 'since'],
  // An error nothing in the panel or the page's recorder caught: where (panel, recorder), its message (redacted, 300 characters)
  // and up to four frames inside the extension's own files. where 'plan': a carrier rule that threw
  // while a plan was built, named by its concept and q.
  client_error: ['where', 'error', 'stack', 'concept', 'q'],
  // AI assistant: one per request to the model, one per suggestion the agent (or the auto-select
  // setting) acted on. Choices are option texts; typed text suggestions are never logged.
  // leave*: why questions were left, as counts (missing information, a conflict, Luna's own leave,
  // no usable citation, an answer the evidence check refused, a question too large to ask).
  // promptHash: which instructions and rules the review got (src/ai/luna.js promptHash).
  ai_suggest: ['model', 'ms', 'items', 'suggested', 'leave', 'autoOk', 'blocked', 'error', 'tokensIn', 'tokensOut', 'modelCalls', 'reasoningTokens', 'cachedTokens', 'cacheWriteTokens', 'promptHash',
    'leaveMissing', 'leaveConflict', 'leaveChose', 'leaveNoSource', 'leaveUnverified', 'leaveTooLarge'],
  // Earlier clients emitted these scores (and categorical confidence); ingestion retains them only.
  // ruleIds: the TNI rules a pick cites, by rulebook id (at most 12).
  ai_decision: ['model', 'policy', 'promptHash', 'probability', 'support', 'evidenceProbability', 'confidence', 'q', 'label', 'controlKind', 'decision', 'choice', 'basis', 'intakePath', 'reason', 'ruleIds'],
  // One per question Luna left: its code and label, why (leaveWhy) and the intake field it maps to.
  ai_leave: ['q', 'label', 'controlKind', 'leaveWhy', 'intakePath'],
  // The quote summary the agent saved (Save summary: sidepanel/panel/quote-summary.js), whole:
  // every answer of the quote per carrier and page with its source, the agent's overrides, the AI's
  // decisions and what was marked done. It holds client data, as the agent saw it in the panel
  // (the maintainer, 2026-11-07: TNI's own server). The server checks its shape whole (SUMMARY_SHAPE).
  quote_summary: ['summary'],
};

// Text in the business profile never holds what could identify the client (ID_LIKE: an @; a date
// with /, - or . between its parts; seven or more digits, even with spaces, dashes, dots, slashes
// or brackets between them, as in a phone, SSN, licence or policy number; five digits in a row; a
// word of eight or more letters and digits mixed, as in a VIN). A limit may also be a limit as
// written (LIMIT: $1M CSL, $1,000,000, 1000000, $1M/$2M, 25/50/25, State Minimum), which can hold
// such digits. The extension applies these before sending (src/usage.js), the server on arrival.
export const ID_LIKE = /@|\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|\d(?:[\s()./-]{0,2}\d){6,}|\d{5,}|\b(?=[a-z]*\d)(?=\d*[a-z])[a-z\d]{8,}\b/i;
// An amount: with thousands commas, round thousands written plainly, or up to four digits with an
// optional K or M; a pair of amounts with a slash ($1M/$2M); a split limit (25/50/25, 100/300/100,
// whose first part is 15 or more, so a date isn't one); a word; & + -.
const MONEY = String.raw`\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$?\d{1,6}000|\$?\d{1,4}(?:\.\d+)?[km]?`;
const LIMIT_PART = String.raw`(?:1[5-9]|[2-9]\d|[1-9]\d{2})(?:\/\d{1,3}){1,2}|(?:${MONEY})(?:\s*\/\s*(?:${MONEY}))?|[a-z]+\.?|[&+-]`;
// Two numbers with only a space, &, + or - between them aren't a limit (an SSN or a phone written
// with spaces: 123 45 6789).
export const LIMIT = new RegExp(String.raw`^(?![\s\S]*\d[\s&+-]+\$?\d)(?:${LIMIT_PART})(?:\s+(?:${LIMIT_PART}))*$`, 'i');
// The most vehicles, trailers, drivers or prior policies a profile lists.
export const PROFILE_UNITS = 50;
