/* oxlint-disable unicorn/no-empty-file -- JSDoc types only, by design: nothing loads this file. */
// @ts-check
// The shapes passed between the extension's parts, as JSDoc types for the type check (`npm run
// typecheck`, tsconfig.json; docs/testing.md). Comments only: nothing loads this file at run time,
// and it sits outside the folders scripts/package.mjs packages, so it is never in the package.
//
// A file checked with `// @ts-check` imports the shapes it names once, below its own imports (from
// src/ or sidepanel/; `../../types.js` from a folder below them):
//   /** @import { CarrierConfig, CarrierRule } from '../types.js' */
// An unchecked file (pagekit.js, sidepanel.js) may name them too, on the functions that make or
// read a shape: editors show it, and the check covers it once that file opts in.
//
// Kept to what the code reads. A key a carrier, rule or action declares that isn't here fails the
// check: either a misspelling, ignored at run time, or a new option to add here, with what it does.
// In a `.map(...)` callback that builds one, only with `/** @returns {CarrierRule} */` on it; never in a
// list written in front of `.map(...)`, which a comment can't type: a list of rules goes to a helper
// typed `@param {CarrierRule[]}` instead (docs/testing.md).

// ---------------------------------------------------------------------------------------------
// The client record and the plan's units

/**
 * The client record normalizeIntake (src/normalize.js) makes from the intake: `applicant`,
 * `garaging`, `operations`, `vehicles`, `trailers`, `drivers`, `coverage`, `priorInsurance`,
 * `claims`, `notes`, … Typed loosely for now: its paths are read everywhere, and its fields are null
 * until the intake answers them.
 * @typedef {{ [key: string]: any }} ClientRecord
 */

/**
 * Something on the intake for the agent to check (normalizeIntake).
 * @typedef {object} IntakeWarning
 * @property {string} code  the kind of problem, without client data (for the usage log)
 * @property {string} path  the record path it is about
 * @property {'check' | 'info'} level
 * @property {string} msg
 */

/**
 * What normalizeIntake makes of a TNI intake (else `{ error }`).
 * @typedef {object} IntakeResult
 * @property {ClientRecord} record
 * @property {IntakeWarning[]} warnings
 * @property {{ fields: number, filled: number }} stats
 * @property {{ drivers: number[], vehicles: number[], trailers: number[] }} rows  the form row (1-4) each unit was read from
 */

/** @typedef {'vehicles' | 'drivers' | 'trailers'} UnitList */

/**
 * Which vehicle, driver and trailer a page is about (by index into the record's lists), and the
 * unit the panel is adding (sidepanel pickUnitToAdd: GEICO's chooser). Other record lists a path
 * names with `[]` are indexed the same way.
 * @typedef {object} ActiveUnits
 * @property {number} [vehicles]
 * @property {number} [drivers]
 * @property {number} [trailers]
 * @property {{ list: UnitList, index: number, click?: boolean } | null} [adding]
 */

/**
 * A value, or a function of the client record and the active units that gives it.
 * @template T
 * @typedef {T | ((record: ClientRecord, active: ActiveUnits) => T)} ClientValue
 */

/**
 * A form told by a question only it asks (a rule's `whenShown` / `unlessShown`).
 * @typedef {object} ShownCondition
 * @property {string} field  the question's data-model name
 * @property {string} [label]  a pattern its text must match
 * @property {UnitList} [unit]  the unit the form is for: the panel's active one
 */

/**
 * What a list offers, for a rule answered only when one of its conditions holds (a rule's
 * `onlyIf`): a limit is a choice with an amount ("$2,500", "$10,000/No deductible"), never a
 * placeholder, GEICO's hidden stand-in, "Not Included" or "I decline".
 * @typedef {object} ListCondition
 * @property {string | null} [path]  another question's plan path, whose list is read (GEICO's Medical Payments reads Basic PIP's); none: the rule's own list
 * @property {boolean} limit  true: the list offers a limit; false: it offers none (a list off the page offers none)
 */

// ---------------------------------------------------------------------------------------------
// Carrier configuration (src/carriers.js and src/carriers/*.js)

/**
 * One exact mapping for a carrier's pages, or a generic label rule (src/rules.js). How it finds
 * its field and where its value comes from: src/carriers.js; what each option does: src/plan.js
 * fieldSteps, which copies it onto the plan step.
 * @typedef {object} CarrierRule
 * @property {string} [name]  what the panel calls the question
 * @property {string} [path]  a client-record path: the answer, unless `value` gives one
 * @property {(record: ClientRecord, active: ActiveUnits) => any} [value]
 * @property {ClientValue<string | null>} [source]  where its answer comes from: one of src/plan.js
 *   SOURCES (Contract 2, docs/intake-and-rules.md), which test/provenance.test.mjs checks for every rule
 * @property {string} [kind]  a value kind (src/schema.js: bool, choice, date, int, money, state, text), or
 *   how the page kit picks it (address-suggest, first-option, pick-not, search-select, selected-option)
 * @property {string} [q]  the carrier's question id (Duck Creek)
 * @property {string} [field]  the field's data-model name
 * @property {string | string[]} [ask]  the question's exact text(s)
 * @property {string} [askAfter]  the first such question after this one, when its text repeats
 * @property {string} [selector]  a CSS selector
 * @property {string} [label]  a pattern on the field's label (rules.js format)
 * @property {string} [not]  a pattern the label must not match
 * @property {string[]} [notWithin]  never a field inside these (the carrier's `rowSections`)
 * @property {string | string[]} [page]  only on these pages
 * @property {string | string[]} [notPages]
 * @property {boolean} [pageOnly]  its data-model name only on its own pages
 * @property {string | string[]} [steps]  only on these steps of a one-address application
 * @property {ClientValue<ShownCondition | null>} [whenShown]
 * @property {ClientValue<ShownCondition | null>} [unlessShown]
 * @property {'select' | 'radio' | 'checkbox' | 'text'} [control]
 * @property {ClientValue<string | null>} [scope]  vehicle, trailer, driver or policy
 * @property {ClientValue<number | null>} [scopeIndex]
 * @property {UnitList} [repeat]  one step per unit of this list
 * @property {(record: ClientRecord, active: ActiveUnits) => string} [repeatSelector]
 * @property {{ selector: string, path: string }} [witness]  the unit's row: the one showing its value
 * @property {ClientValue<string | null>} [note]  left to the agent with this note, never filled
 * @property {ClientValue<string | null>} [warn]  filled, and marked for the agent to confirm
 * @property {ClientValue<string | null>} [emptyNote]
 * @property {ClientValue<boolean>} [ignore]
 * @property {boolean} [every]
 * @property {ClientValue<boolean>} [verifyOnly]  checked against the intake, never typed
 * @property {boolean} [clientFact]  the agent's when the intake leaves it without an answer
 * @property {boolean} [optional]
 * @property {boolean} [each]
 * @property {boolean} [hidden]
 * @property {boolean} [replace]
 * @property {boolean} [trustPage]
 * @property {boolean} [keepChoice]
 * @property {boolean} [keepUnlisted]
 * @property {boolean} [whenOffered]
 * @property {{ count: string, one?: string, after: string, name: string }} [orMost]
 * @property {ClientValue<string | null>} [waitFor]
 * @property {boolean} [registeredName]
 * @property {(record: ClientRecord, active: ActiveUnits) => string[] | null} [businessNames]
 * @property {(record: ClientRecord, active: ActiveUnits) => string[] | null} [labelHas]
 * @property {string} [labelNote]
 * @property {ClientValue<ListCondition[] | null>} [onlyIf]  answered only when one of these holds (GEICO's Medical Payments, Not Included: Basic PIP offers a limit, or Medical Payments none); otherwise the agent's alone (manual only), with `onlyNote`
 * @property {string} [onlyNote]
 * @property {ClientValue<string | null>} [unofferedNote]  a list without the answer, which no helper shows later (GEICO's Basic PIP without $2,500): the agent's alone at once, with this note, instead of a failure
 * @property {boolean} [checkNumber]
 * @property {'section' | 'limit' | true} [cargo]
 * @property {'section' | 'limit'} [gl]
 * @property {string} [group]
 * @property {ClientValue<string | null>} [summaryAfter]
 * @property {ClientValue<string[]>} [choiceAliases]
 * @property {ClientValue<string | null>} [fallback]
 * @property {ClientValue<string | null>} [search]
 * @property {ClientValue<string | null>} [withOption]
 */

/**
 * A carrier button the fill may click (a lookup, Add Driver, Recalculate, …): src/plan.js
 * actionSteps resolves it for the client and says what each option does. Never Continue, Bind,
 * Submit or Buy: those are the carrier's `advance` or the agent's.
 * @typedef {object} CarrierAction
 * @property {string} id
 * @property {ClientValue<string | null>} [text]  a pattern on the button's words
 * @property {string} [token]  a string in its id, href or onclick
 * @property {string} [near]
 * @property {string} [within]
 * @property {string} [opener]  a menu button that shows it
 * @property {string | string[]} [page]
 * @property {string | string[]} [steps]
 * @property {(record: ClientRecord, active: ActiveUnits) => boolean} [when]  clicked only for these clients
 * @property {'vehicle' | 'driver' | 'trailer' | null} [scope]  tracked per unit; a value, never a function (src/plan.js names the action by it)
 * @property {ClientValue<number | null>} [scopeIndex]
 * @property {string} [label]  what the panel calls it
 * @property {ClientValue<string | null>} [missing]  what the panel says when it can't be clicked
 * @property {boolean} [markable]  its reminder (`missing`) has a Mark done that marks the helper done for the tab: only for a step the agent does instead, never a hold the page settles (`resolvedBy`) or a question answered on the Intake step
 * @property {ClientValue<string | null>} [unfinished]
 * @property {ClientValue<string[]>} [after]  record paths whose answers must be on the page first
 * @property {ClientValue<string[]>} [afterAny]
 * @property {ClientValue<string[]>} [unless]
 * @property {ClientValue<string | null>} [unlessSelector]
 * @property {ClientValue<string[]>} [unlessActions]
 * @property {ClientValue<string[]>} [afterActions]
 * @property {ClientValue<string[]>} [afterPages]
 * @property {ClientValue<[string, string] | null>} [afterValue]  a path and a pattern its choice must match
 * @property {ClientValue<string[]>} [doneWhen]
 * @property {ClientValue<string[]>} [heldBy]
 * @property {string} [resolvedBy]
 * @property {ClientValue<string[]>} [settledByPages]
 * @property {string} [nudge]
 * @property {{ all?: string[], any?: string[], answered?: boolean }} [shownBy]
 * @property {ClientValue<boolean>} [needsPremium]
 * @property {ClientValue<boolean>} [needsRecalculation]
 * @property {ClientValue<ActionVerify | null>} [verify]
 * @property {ClientValue<string | null>} [ratedBy]  with `verify: 'premium'`, a selector the page draws only once it rated (GEICO's pay plans)
 * @property {ClientValue<number | null>} [quietMs]  how long the page is quiet before the click
 * @property {boolean} [moveOn]
 * @property {boolean} [loads]
 * @property {boolean} [unique]
 * @property {boolean} [immediate]
 * @property {boolean} [skipIfProtected]
 * @property {boolean} [waitRequired]
 * @property {boolean} [whenClear]  only once nothing on the page is left for the agent
 * @property {boolean} [once]  once a quote
 * @property {boolean} [keepAnswers]  answers checked once its result shows (GEICO's Recalculate)
 * @property {boolean} [kitClick]  clicked by the kit even where the carrier presses its buttons from the page's own world (`pressInPage`): GEICO's Print Quote Proposal
 */

/**
 * How a click is known to have worked (pagekit fill): its result shows the premium, reveals more,
 * starts a download, the button goes, a coverage closes, or `appears` matches more than before.
 * @typedef {'premium' | 'revealed' | 'download' | 'gone' | 'cargoClosed' | 'glClosed' | { appears: string }} ActionVerify
 */

/**
 * The carrier's Continue: clicked once nothing on the page is left for the agent (pagekit fill
 * `advance`, after src/units.js advanceFor).
 * @typedef {object} CarrierAdvance
 * @property {string} text  a pattern on the button's words
 * @property {string} [listed]  a unit list's Continue, once every intake unit is on it (GEICO's Looks Good)
 * @property {string[]} [steps]  only on these steps
 * @property {string[]} [exceptPages]  never on these pages
 * @property {string} [notWithin]  never a button inside this
 * @property {boolean} [byForm]  continued per form and button
 * @property {number} [quietMs]  how long the page is quiet first; a fill that gave answers waits for that before it ends and answers what was drawn meanwhile
 */

/**
 * The business classes a carrier's rules were checked for (src/plan.js supportedClass).
 * @typedef {RegExp | { re: RegExp, whatHaul?: boolean }} SupportedClass
 */

/**
 * One entry of the side panel's page strip: its pages, or the one-address step it is.
 * @typedef {object} QuoteStep
 * @property {string} name
 * @property {string[]} [pages]
 * @property {string} [step]
 */

/**
 * @typedef {object} UnitListSpec  a step's list of the quote's units (src/units.js)
 * @property {string[]} steps
 * @property {string} selector
 * @property {UnitList[]} lists
 */

/**
 * @typedef {object} UnitNameSpec  a form that names its unit ("Questions about <name>")
 * @property {string} page
 * @property {UnitList} list
 * @property {string} text  a pattern whose first group is the name
 */

/**
 * A carrier's settings and mappings (src/carriers.js describes each). `practice` is set by
 * carrierForUrl on the repository's practice pages, never by a carrier file.
 * @typedef {object} CarrierConfig
 * @property {string} id
 * @property {string} name
 * @property {RegExp[]} hosts  also needs a manifest.json host permission
 * @property {CarrierRule[]} rules
 * @property {CarrierAction[]} [actions]
 * @property {CarrierAdvance} [advance]
 * @property {'MAIN'} [world]  the page script in the page's own JavaScript world (ExtJS)
 * @property {boolean} [pressInPage]  buttons pressed from the page's own world (src/content/page-press.js)
 * @property {RegExp | null} [autoFillUrl]  null on a practice page
 * @property {RegExp | null} [layoutUrl]
 * @property {RegExp} [fillOnDraw]
 * @property {string[]} [layoutSteps]
 * @property {QuoteStep[]} [quoteSteps]
 * @property {boolean} [useGenericRules]
 * @property {string[]} [rowSections]
 * @property {SupportedClass[]} [supportedClasses]
 * @property {boolean} [replaceChoices]
 * @property {boolean} [batch]
 * @property {string} [components]  the carrier's own element prefix (GEICO's gds-)
 * @property {{ pages: string[], key: string }} [quoteState]
 * @property {string[]} [vehicleSteps]
 * @property {string[]} [driverSteps]
 * @property {string} [vehicleList]
 * @property {string[]} [vehiclePages]
 * @property {string} [trailerList]
 * @property {string[]} [trailerPages]
 * @property {string} [trailerPage]
 * @property {string} [driverList]
 * @property {string} [driverPage]
 * @property {UnitListSpec[]} [unitLists]
 * @property {UnitNameSpec[]} [unitNames]
 * @property {(record: ClientRecord) => number} [listedDriver]  the intake driver the carrier lists itself, -1 for none
 * @property {{ [page: string]: string | null | ((record: ClientRecord) => string | null) }} [agentPages]
 * @property {{ [page: string]: string }} [stopPages]
 * @property {{ [step: string]: string }} [stopSteps]
 * @property {{ [name: string]: { button: string, note: string | ((record: ClientRecord) => string) } }} [stopButtons]
 * @property {{ [step: string]: string }} [stepNotes]
 * @property {string} [finishedBy]  the action (its id) whose click ends the quote where TNI stops on this rater (GEICO's Print Quote Proposal, Progressive's Print, Email, Fax): clicked, on its step or page, with nothing left for the agent, the panel says "Quote done" (sidepanel quoteFinished); its click where it wasn't done, or was changed or re-armed since, chimes (noteQuoteDone)
 * @property {{ id: string, steps: string[], left: string[], said: string, sub: string }} [finishedAt]  where the quote ends at a step instead of a button (AmWINS: Underwriting, with only the Declaration left for the agent): a fill there that leaves the agent nothing but the `left` items (by rule name) is the quote done: Review page says "Quote done", the dock says `said` and `sub`, and the chime sounds once a quote (`id` kept with the tab's done actions; sidepanel quoteFinished, rememberFill)
 * @property {string} [finishedSaid]  the dock's title then, in place of "The quote proposal is printed" (Progressive: "Print, Email, Fax was clicked")
 * @property {string[]} [newQuestionsOnlySteps]
 * @property {string[]} [keepTakenBack]
 * @property {boolean} [continueRetry]
 * @property {boolean} [practice]
 */

// ---------------------------------------------------------------------------------------------
// The plan (src/plan.js buildPlan), sent into the page with the fill

/**
 * A field step: one question's answer, resolved for this client, and how the page kit finds its
 * field. Most keys are the rule's, resolved (src/plan.js fieldSteps).
 * @typedef {object} FieldStep
 * @property {number} id
 * @property {string} path
 * @property {string} name
 * @property {string} kind
 * @property {string | null} source  one of src/plan.js SOURCES
 * @property {boolean} standard
 * @property {boolean} reviewRequired
 * @property {boolean} manualOnly
 * @property {string | null} q
 * @property {string | null} field
 * @property {string[] | null} ask
 * @property {string[] | null} pages
 * @property {string[] | null} steps
 * @property {{ field: string, label: string | null, unit: UnitList | null } | null} whenShown
 * @property {{ field: string, label: string | null, unit: UnitList | null } | null} unlessShown
 * @property {string | null} control
 * @property {boolean} pageOnly
 * @property {string[] | null} notPages
 * @property {string | null} askAfter
 * @property {string | null} waitFor
 * @property {boolean} each
 * @property {boolean} optional
 * @property {boolean} registeredName
 * @property {'section' | 'limit' | true | null} cargo
 * @property {'section' | 'limit' | null} gl
 * @property {string | null} selector
 * @property {string | null} re  the rule's `label` pattern
 * @property {string | null} ex  the rule's `not` pattern
 * @property {string[] | null} notWithin
 * @property {string | null} note
 * @property {boolean} ignore
 * @property {boolean} every
 * @property {boolean} verifyOnly
 * @property {boolean} replace
 * @property {boolean} trustPage
 * @property {boolean} keepChoice
 * @property {boolean} keepUnlisted
 * @property {boolean} whenOffered
 * @property {{ count: string, one: string | null, after: string, name: string } | null} orMost
 * @property {boolean} hidden
 * @property {string | null} group
 * @property {string | null} emptyNote
 * @property {string | null} warn
 * @property {string | null} summaryAfter
 * @property {string[]} choiceAliases
 * @property {string | null} scope
 * @property {number | null | undefined} scopeIndex
 * @property {string[] | null} vehicleHint  the unit's year, make and model, which pick its row
 * @property {boolean | null} activeVehicle
 * @property {string[] | null} businessNames
 * @property {string[] | null} labelHas
 * @property {string | null} labelNote
 * @property {{ path: string | null, limit: boolean }[] | null} onlyIf
 * @property {string | null} onlyNote
 * @property {string | null} unofferedNote
 * @property {string | null} fallback
 * @property {boolean} checkNumber
 * @property {string | null} search
 * @property {string | null} withOption
 * @property {any} value  null when there is none
 * @property {string[] | null} from  a derived answer's evidence: the record paths it read
 * @property {{ selector: string, path: string, value: any } | null} witness
 */

/**
 * An action step: a carrier button, resolved for this client (src/plan.js actionSteps). `action`
 * is its id, per unit where it is scoped to one (`addDriver:1`); `baseAction` the carrier's id.
 * @typedef {object} ActionStep
 * @property {string} id
 * @property {'action'} kind
 * @property {string} action
 * @property {string} baseAction
 * @property {string} path
 * @property {string} name
 * @property {string[]} pages
 * @property {string[] | null} steps
 * @property {string | null} text
 * @property {string | null} token
 * @property {string | null} near
 * @property {string | null} within
 * @property {boolean} moveOn
 * @property {boolean} loads
 * @property {boolean} unique
 * @property {string | null} label
 * @property {string | null} missing
 * @property {boolean} markable
 * @property {string[]} heldBy
 * @property {string | null} resolvedBy
 * @property {string[]} settledByPages
 * @property {string | null} opener
 * @property {string | null} nudge
 * @property {boolean} immediate
 * @property {boolean} skipIfProtected
 * @property {string[]} after
 * @property {string[]} afterAny
 * @property {string[]} unless
 * @property {string | null} unlessSelector
 * @property {string[]} doneWhen
 * @property {boolean} waitRequired
 * @property {boolean} whenClear
 * @property {number | null} quietMs
 * @property {boolean} once
 * @property {boolean} keepAnswers
 * @property {boolean} kitClick
 * @property {string | null} unfinished
 * @property {string[]} unlessActions
 * @property {string[]} afterActions
 * @property {string[]} afterPages
 * @property {[string, string] | null} afterValue
 * @property {boolean} needsPremium
 * @property {boolean} needsRecalculation
 * @property {ActionVerify | null} verify
 * @property {string | null} ratedBy
 * @property {{ all: string[], any: string[], answered: boolean } | null} shownBy
 * @property {'vehicle' | 'driver' | 'trailer' | null} scope
 * @property {number | null | undefined} scopeIndex
 * @property {null} value
 */

/** @typedef {FieldStep | ActionStep} PlanStep */

// ---------------------------------------------------------------------------------------------
// The fill (src/content/pagekit.js `fill`)

/**
 * What the side panel passes the page kit's fill (sidepanel fillOptions; pagekit fill says what
 * each does). Every key is optional: the kit has a default for each.
 * @typedef {object} FillOptions
 * @property {boolean} [overwrite]
 * @property {number} [maxRounds]
 * @property {string[]} [skip]  field keys the agent edited
 * @property {boolean} [keepMarks]
 * @property {string[]} [doneActions]
 * @property {boolean} [replaceChoices]
 * @property {string[]} [visitedPages]
 * @property {CarrierAdvance | null} [advance]
 * @property {boolean} [batch]
 * @property {string[]} [doneSteps]
 * @property {string[]} [stopPages]
 * @property {string[]} [stopSteps]
 * @property {any} [units]
 * @property {{ steps?: { [step: string]: string[] }, stepUnits?: { [step: string]: any }, units?: { [list: string]: string[] }, forms?: { [id: string]: string[] } } | null} [skipBy]
 * @property {{ steps: string[], keys: { [key: string]: true } } | null} [takenBack]
 * @property {boolean} [hold]
 * @property {any} [confirmed]  the page's receipt as the agent approved it
 * @property {string | null} [run]
 * @property {number} [loadResultMs]
 * @property {string[]} [filledBefore]
 * @property {string | null} [expectPage]
 * @property {string | null} [components]
 * @property {{ list: UnitList, text: string, names: string[][], active: number, label: string } | null} [formUnit]
 *   a form that names its unit (carrier `unitNames`): each intake unit's name words, and the plan's unit
 * @property {{ [key: string]: any }} [givenBefore]
 */

/**
 * One question in a fill report: its field, the plan step that answered it (when one did), and
 * what happened. Which keys are set depends on the list it is in.
 * @typedef {object} FillItem
 * @property {number | null} [stepId]
 * @property {string | null} [label]  the question as the page shows it
 * @property {string | null} [path]
 * @property {string} [name]
 * @property {string | null} key  the field key (src/content/field-key.js)
 * @property {string | null} [q]
 * @property {string | null} [controlKind]  select, radio, checkbox, text
 * @property {string} [how]  how its field was found
 * @property {boolean} [standard]
 * @property {boolean} [manualOnly]
 * @property {string | null} [source]
 * @property {boolean} [review]
 * @property {boolean} [otherStep]
 * @property {string} [note]  why it is the agent's
 * @property {string | null} [action]  a markable helper's reminder: the helper's id as the fill tracks it (scoped: `vehicleTile:0`), for the tab's done actions
 * @property {string} [reason]  why it failed
 * @property {string} [shown]  what the page shows (a choice's text)
 * @property {string} [said]
 * @property {boolean} [differs]
 * @property {boolean} [reviewOnly]
 * @property {boolean} [required]
 * @property {string | null} [ref]
 * @property {string[]} [options]  describe(): the field's choices
 * @property {string | null} [section]
 * @property {string | null} [current]
 * @property {number} [order]  its place on the page
 * @property {string} [unit]
 * @property {object} [timing]
 */

/**
 * What a button waits for (FillReport `blocked`): a question's answer (`path`, or `set` once any
 * answer), one of several (`any`), another button, a visit to one of these pages, or words to show.
 * @typedef {object} FillWait
 * @property {string} [path]
 * @property {boolean} [set]
 * @property {string[]} [any]
 * @property {string} [action]
 * @property {string[]} [pages]
 * @property {string} [say]
 */

/**
 * The trace of a helper that rates the answers (GEICO's Recalculate, W43-44): how it was pressed,
 * when the premium showed, the page's requests and each choice it kept, in ms after the click.
 * @typedef {object} RecalcTrace
 * @property {string} action
 * @property {number} ms
 * @property {'page' | 'late' | 'kit' | null} press  from the page's own world, there without the browser's event, or a script's click
 * @property {number | null} premiumMs
 * @property {([number, number] | [number, number, 1])[]} requests  [start, end], and 1 for a request on the page's steady beat (pagekit isBeat), which no wait counts
 * @property {{ label: string, key: string | null, shown: string, agents: boolean, seen: [number, string][], putBack: boolean }[]} answers
 */

/**
 * What the page kit's fill returns, one per frame (the side panel's `frames`).
 * @typedef {object} FillReport
 * @property {string} frame  the frame's origin and path
 * @property {number} fields
 * @property {number} rounds
 * @property {FillItem[]} filled
 * @property {FillItem[]} noData  left for the agent
 * @property {FillItem[]} kept  already on the page
 * @property {FillItem[]} failed
 * @property {FillItem[]} leftRequired
 * @property {FillItem[]} unknown  unfamiliar questions
 * @property {FillItem[]} checks
 * @property {{ label: string | null, key: string | null, name: string, field: string | null }[]} reworded
 * @property {{ label: string | null, key: string | null, name: string, field: string | null, now: string | null }[]} renamed
 * @property {{ id: string, text: string, alreadyShown?: boolean }[]} actions  buttons clicked, or found done
 * @property {{ id: string, why: string, waits?: FillWait[], text?: string }[]} blocked  buttons not clicked yet, and why
 * @property {string[]} protectedKeys
 * @property {string[]} invalidatedActions
 * @property {boolean} halted
 * @property {string} [reason]  why it halted
 * @property {string[]} [blockers]  what holds Continue
 * @property {{ list: UnitList, id: string } | null} unitForm
 * @property {{ list: UnitList, id: string } | null} unitHeld
 * @property {{ list: UnitList, index: number }} [unitNamed]
 * @property {boolean} [unitMismatch]
 * @property {boolean} stepUnread
 * @property {string | null} [stepKey]
 * @property {string} [stopStep]
 * @property {string} [pageMoved]
 * @property {string} [navigatedTo]
 * @property {boolean} [pageChanged]
 * @property {[string, string][]} [labels]  field key, question text
 * @property {[string, string[]][]} [choices]  field key, a combo's options
 * @property {{ label: string | null, key: string | null }[]} [skipped]
 * @property {string} [advanced]  the Continue it pressed
 * @property {string} [advanceKey]
 * @property {'busy' | 'none'} [advanceDue]
 * @property {'check' | 'changed'} [held]
 * @property {boolean} [agentPressed]
 * @property {boolean} [covered]
 * @property {string[]} [coveredHelpers]
 * @property {boolean} [documentPending]
 * @property {boolean} [notDrawn]
 * @property {any} [signatureBefore]
 * @property {RecalcTrace} [recalcTrace]
 */

// ---------------------------------------------------------------------------------------------
// Usage events (src/usage.js). The panel's logger (sidepanel/usage-log.js) adds the time, version
// and copy to each.

/**
 * @typedef {object} IntakeSummary  intakeSummary: what kind of intake, without the client
 * @property {string} intakeId
 * @property {string} formVersion
 * @property {number} answers
 * @property {string | null} state
 * @property {string | null} businessClass
 * @property {string[]} vehicleTypes
 * @property {{ drivers: number, vehicles: number, trailers: number }} counts
 * @property {string[]} coverages
 * @property {{ code: string, path: string, level: 'check' | 'info' }[]} warnings
 */

/**
 * @typedef {object} IntakeProfileEvent  intakeProfile: the business without names or numbers
 * @property {'intake_profile'} type
 * @property {object} business
 * @property {object} operations
 * @property {object[]} vehicles
 * @property {object[]} trailers
 * @property {object} trailerInfo
 * @property {object[]} drivers
 * @property {object} coverage
 * @property {object[]} priorInsurance
 * @property {boolean | null} hasClaims
 */

/**
 * @typedef {object} CheckDismissedEvent
 * @property {'check_dismissed'} type
 * @property {string | null} q
 * @property {string | null} key
 * @property {string} label
 * @property {string | null} mark
 */

/**
 * @typedef {object} AgentSettingsEvent
 * @property {'agent_settings'} type
 * @property {string} [reason]  intake, opened or changed
 * @property {string} [changed]
 * @property {{ autoFollowUps: boolean, autoAdvance: boolean, autoPages: boolean, overwrite: boolean, aiOn: boolean, aiAuto: boolean, aiKey: boolean, uploads: 'off' | 'central' | 'other' }} values
 */

/**
 * @typedef {object} ClientErrorEvent
 * @property {'client_error'} type
 * @property {string} [where]
 * @property {string} error
 * @property {string[]} [stack]
 */

/**
 * @typedef {object} FieldChangeEvent  fieldChangeEvent: one change the page recorder saw
 * @property {'field_change'} type
 * @property {string | null} q
 * @property {string | null} key
 * @property {string} label
 * @property {string} kind
 * @property {'agent' | 'page'} by
 * @property {string | null} autofilled  the record path the fill answered it from
 * @property {string} [step]
 * @property {'entered' | 'cleared' | 'edited'} [change]  a text box
 * @property {string[]} [matchesIntake]
 * @property {string | null} [from]  a choice
 * @property {string | null} [to]
 * @property {string} [vsAutofill]
 */

/**
 * @typedef {object} FillRunEvent  fillEvents: one fill run's totals
 * @property {'fill_run'} type
 * @property {string} carrier
 * @property {string} page
 * @property {string} view
 * @property {boolean} overwrite
 * @property {boolean | string} auto
 * @property {number} ms
 * @property {string} [run]
 * @property {string} [rules]
 * @property {object} [settings]
 * @property {string} [step]
 * @property {number} fields
 * @property {number} rounds
 * @property {number} filled
 * @property {number} kept
 * @property {number} noData
 * @property {number} failed
 * @property {number} leftRequired
 * @property {number} unknown
 * @property {string[]} clicked
 * @property {number} blockers
 * @property {string[]} blockerList
 * @property {string | null} advanced
 * @property {boolean} pageChanged
 * @property {number} reworded
 * @property {{ name: string, field: string | null, now: string | null }[]} renamed
 */

/**
 * @typedef {object} FillFieldEvent  fillEvents: one question of a fill run
 * @property {'fill_field'} type
 * @property {string} carrier
 * @property {string} page
 * @property {string} view
 * @property {string} [run]
 * @property {string} [step]
 * @property {'filled' | 'failed' | 'noData' | 'kept' | 'leftRequired' | 'unfamiliar'} result
 * @property {string | null} q
 * @property {string | null} key
 * @property {string} label
 * @property {string | null} path
 * @property {string | null} controlKind
 * @property {string} [how]
 * @property {string} [source]
 * @property {true} [standard]
 * @property {true} [manualOnly]
 * @property {true} [review]
 * @property {string} [shown]
 * @property {string} [reason]
 * @property {string[]} [options]
 * @property {object} [timing]
 */

/**
 * @typedef {object} RecalcLayoutEvent  fillEvents: a RecalcTrace, as a page layout
 * @property {'page_layout'} type
 * @property {string} carrier
 * @property {string} page
 * @property {string} view
 * @property {string} [step]
 * @property {'recalculate'} reason
 * @property {{ action: string | null, ms: number | null, press: 'page' | 'late' | 'kit' | null, premiumMs: number | null, requests: ([number, number] | [number, number, 1])[] }} context
 * @property {{ label: string, key: string | null, selected: string, agents: boolean, seen: [number, string][], putBack: boolean }[]} fields
 */

/**
 * @typedef {object} AiSuggestEvent  sidepanel.js runAssist: one Luna page review (counts only)
 * @property {'ai_suggest'} type
 * @property {string} model
 * @property {string} carrier
 * @property {string} [page]
 * @property {number} items  questions sent
 * @property {number} blocked  questions kept from Luna (never-list, manual-only)
 * @property {number} [ms]  time the review took
 * @property {number} [suggested]
 * @property {number} [autoOk]  answers allowed as automatic picks
 * @property {number} [leave]  questions left to the agent; the leave* counts below say why
 * @property {number} [leaveMissing]  Luna said information is missing
 * @property {number} [leaveConflict]  Luna saw conflicting facts
 * @property {number} [leaveChose]  Luna left it without either
 * @property {number} [leaveNoSource]  it answered but cited nothing usable
 * @property {number} [leaveUnverified]  the evidence check refused its answer
 * @property {number} [tokensIn]
 * @property {number} [tokensOut]
 * @property {number} [modelCalls]
 * @property {number} [reasoningTokens]
 * @property {number} [cachedTokens]
 * @property {number} [cacheWriteTokens]
 * @property {string} [error]
 */

/**
 * The events src/usage.js builds. The panel logs others of its own (sidepanel.js).
 * @typedef {IntakeProfileEvent | CheckDismissedEvent | AgentSettingsEvent | ClientErrorEvent | FieldChangeEvent | FillRunEvent | FillFieldEvent | RecalcLayoutEvent} UsageEvent
 */

// ---------------------------------------------------------------------------------------------
// The developer recording (docs/developer-recording.md)

/**
 * One event of a recording's timeline: what src/content/trace.js saw in a frame, as the panel keeps
 * it (src/recording.js stampEvents), or a mark of the panel's own (`note`, `gap`).
 * @typedef {object} TraceEvent
 * @property {string} kind  page, step, pointer, click, key, input, change, focus, blur, scroll, visible, resize; the panel's: fill, note, gap
 * @property {boolean} [on]  a fill starting (true) or ending (fill)
 * @property {number} t  wall-clock ms when it happened, on the page's own clock (a fraction kept)
 * @property {number} [seq]  the frame's counter: the order of two events in one millisecond
 * @property {number} [frame]  the frame it came from (0: the top frame)
 * @property {true} [filling]  a fill was under way when it happened (by its own time, from the fills the panel notes)
 * @property {boolean} [trusted]  the browser's isTrusted: a person's action, not a script's
 * @property {number | null} [gestureMs]  ms since the last trusted gesture on that control (input, change)
 * @property {{ key: string | null, q: string | null, kind: string | null, label: string, rect: object | null }} [field]  the question, as the recorder names it (label redacted)
 * @property {{ text: string, rect: object | null }} [button]  the button, by its words (redacted)
 * @property {string | null} [value]  a choice's words after the change (redacted)
 * @property {number} [len]  a text box's length after the change; its text is never kept
 * @property {string} [key]  a named key (Enter, Tab, Space, arrows…); a typed character never
 * @property {boolean} [printable]  a key that types a character, which isn't kept
 * @property {string} [page]  the page as the usage log names it (page, step)
 * @property {string | null} [step]  the step on screen (null: none, or unreadable mid-redraw)
 * @property {string} [title]  the document's title (redacted)
 * @property {string} [text]  a note's words (redacted)
 * @property {number} [dropped]  events the trace couldn't keep while no panel took them (gap)
 * @property {number | null} [x]  pointer, click: where, in the viewport; scroll of the window: its position
 * @property {number | null} [y]  as x
 * @property {string[]} [mods]  key: the modifiers held (ctrl, alt, meta, shift)
 * @property {{ tag: string | null }} [other]  what a pointer, click or key was on when it was no question or button
 * @property {string} [path]  page: the URL's path, its ids as `:id` (as `page`)
 * @property {boolean | number | null} [top]  page: from the top frame (true); scroll of an element: its offset
 * @property {string | null} [from]  page, step: the one before
 * @property {{ w: number | null, h: number | null, dpr: number | null }} [viewport]  page: the viewport (resize: as w, h, dpr)
 * @property {{ x: number | null, y: number | null }} [scroll]  page: the window's scroll
 * @property {number | null} [height]  scroll of the window: the page's height
 * @property {{ tag: string, id: string | null }} [el]  scroll of an element: which
 * @property {number | null} [left]  scroll of an element: its offset (with top)
 * @property {number | null} [w]  resize: the viewport's width
 * @property {number | null} [h]  resize: the viewport's height
 * @property {number | null} [dpr]  resize: devicePixelRatio
 * @property {string} [state]  visible: the document's visibilityState
 * @property {string} [why]  visible: pageshow or pagehide, when it came from one
 * @property {number} [ms]  fill, in the report only: how long the fill ran (on its end)
 */

/**
 * A recording's recording.json.
 * @typedef {object} RecordingManifest
 * @property {'tni-rater-autofill'} tool
 * @property {'recording'} kind
 * @property {number} version  the format's version
 * @property {string} id  <carrier>-<scenario>-<yyyymmdd-hhmm>-<4 hex>
 * @property {string} carrier
 * @property {string} scenario  as typed in the panel's Scenario box (redacted)
 * @property {string} started  ISO time
 * @property {string | null} ended  ISO time; null while recording, or for one cut short
 * @property {{ version: string, channel: string, commit: string | null }} build
 * @property {string | null} intake  the intake's fingerprint (no client data)
 * @property {boolean} test  marked as a test run, not a client
 * @property {number} events  how many events were kept
 * @property {number} dropped  how many the trace couldn't keep
 */
