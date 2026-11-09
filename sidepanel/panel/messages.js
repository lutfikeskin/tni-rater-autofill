// @ts-check
// What the panel says to the agent, by id, in one place (audit 2026-11-07, UX-17): the dock's words
// (dockFor, fillingSaid and continueSaid in coordinator.js), the head of a page's report and what it
// announces (renderReport in fill.js), the intake checks' title (renderWarnings in record.js), and
// the answers' source tags (answerSource in fill.js).
// Each entry holds words only: which one is said, with which button, tone and phase, stays with the
// code that decides it. An entry is a string, or a function of what its words name. The ids are the
// keys a translated catalog (chrome.i18n) would use.
// The assistant is "the AI assistant" here, never Luna (maintainer, 2026-11-07; docs/ai-assistant.md).
// One part of the panel; the parts import it.

const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);

// The dock: the one next thing to do (steps-view.jsx draws it).
export const DOCK = {
  start: { eyebrow: 'Start', title: 'Add the client’s intake PDF', sub: 'The panel checks it and fills the rater.' },
  // A page with intake checks not looked at yet, said in place of the dock's own line.
  checksLeft: (open) => `${open} intake ${plural(open, 'item')} not looked at yet. You can still fill.`,
  preview: { eyebrow: 'Preview', title: 'Filling works only in the Chrome extension' },
  unreadable: { eyebrow: 'Next', title: 'The extension can’t read this page', sub: 'Allow it on this site (toolbar icon or site access), then reload.' },
  // Its line names the raters the panel fills (ratersSaid, from the carriers' registry).
  openRater: { eyebrow: 'Next', title: 'Open the client’s quote on a rater' },
  stopped: (carrier) => ({ eyebrow: `Stopped by ${carrier}`, title: 'Nothing to fill on this rater', sub: 'Nothing on this page was filled or clicked.' }),
  // A step or screen that is the agent's (`what`: its name; `screen`: a screen, not a step).
  yours: (what, screen) => ({ eyebrow: 'This step is yours', title: `Finish ${what ?? 'this step'} yourself`, sub: `Nothing on this ${screen ? 'screen' : 'step'} is filled or clicked.` }),
  stateHold: (intake, picked) => ({ eyebrow: 'Check first', title: 'Sort out the state above', sub: `${intake} answers fail on a ${picked} quote.`, label: 'Fill this page', altLabel: 'Fill anyway' }),
  defaultsAsk: { eyebrow: 'Check first', title: 'Whose defaults does this quote take?', sub: 'Your own defaults, or TNI\'s standards, for this quote.', label: 'Show the question' },
  defaultsHeld: { eyebrow: 'Check first', title: 'Answer the question above', sub: 'Your own defaults, or TNI\'s standards, for this quote.', label: 'Fill this page' },
  otherClient: { eyebrow: 'Check first', title: 'Another client’s quote?', sub: 'This tab’s quote wasn’t started with this intake. Nothing fills here by itself.', label: 'Fill this page' },
  portal: { eyebrow: 'Next', title: 'Open the client’s quote', sub: 'This is the portal. Filling starts on a quote page.' },
  fill: 'Fill this page',
  fillAgain: 'Fill this page again',
  error: { eyebrow: 'Didn’t finish', title: 'Check the page, then fill again', sub: 'Your changes are kept.' },
  // The quote done where TNI stops on the rater (the carrier's own words first: finishedAt, finishedSaid).
  finished: (carrier) => ({ eyebrow: 'Quote done', title: 'The quote proposal is printed', sub: `This is where TNI stops on ${carrier}. Nothing is submitted or bound.`, label: 'Quote summary', altLabel: 'Fill this page again' }),
  stoppedFill: (filled) => ({ eyebrow: 'Stopped', title: `${filled} filled before you stopped`, sub: 'Fill again to finish. Your changes are kept.', label: 'Fill this page again' }),
  // AI picks waiting for the agent's approval (`n` of them, `waiting` not rejected; `continues`:
  // approving also continues; `canContinue`: Continue would be next).
  ai: { eyebrow: (n) => `AI picked ${n} ${plural(n, 'answer')}`,
    title: (waiting) => (waiting ? 'Check the purple answers, then approve' : 'Confirm the page answer, or change it'),
    sub: (someRejected, canContinue) => (someRejected ? 'Continue waits until you confirm the page answer or change it.'
      : canContinue ? 'Continue waits until you approve them.' : 'Check them (purple on the page), then approve.'),
    label: (waiting, continues) => (waiting ? (continues ? 'Approve and continue' : `Approve ${waiting === 1 ? 'the AI pick' : `${waiting} AI picks`}`)
      : continues ? 'Confirm and continue' : 'Confirm the page answer') },
  skipNext: 'Skip to the next one',
  // What a fill of this page will and won't do, before it.
  hint: {
    background: 'Fills the quote tab in the background. Go back to it to review.',
    addsUnits: 'Adds missing vehicles, trailers and drivers, and clicks Next up to Quote & Coverages. Never submits or binds.',
    notContinued: 'Fills what it can. This page isn’t one the extension continues on: Continue is yours.',
    continues: 'Clicks Continue once nothing is left for you. Never submits or binds.',
    manual: 'Nothing is submitted. Review, then click Next yourself.',
  },
  ready: (pageName) => ({ eyebrow: 'Next', title: pageName ? `Fill the ${pageName} page` : 'Fill this page' }),
};

// The dock while a fill runs, with Stop (fillingSaid).
export const FILLING = {
  stop: 'Stop',
  stopping: 'Stopping…',
  eyebrow: (filled) => `Filling · ${filled} in`,
  stoppingEyebrow: 'Stopping',
  stoppingTitle: 'Stopping after the answer going in now…',
  elsewhere: (carrier) => ({ title: `Filling your other ${carrier ?? 'quote'} tab`, sub: 'Its answers show when you go back to it.' }),
  unanswered: { title: 'The page isn’t answering', sub: 'If it shows a message box, answer it there. The fill goes on after.' },
  phase: (said) => `${said}…`,
  justFilled: (label) => `Just filled: ${label || 'an answer'}`,
  reading: 'Reading the page…',
  about: (judged, seen) => `About ${Math.min(judged, seen)} of ${seen} on this page`,
  sub: 'Keep this tab open.',
};

// The dock's word on a page the fill went through (continueSaid).
export const CONTINUE = {
  looksRight: 'Looks right, continue',
  fillAgain: 'Fill this page again',
  continued: (button) => ({ eyebrow: 'Continued', title: 'Continue clicked', sub: `Clicked “${button}” for you. Nothing is submitted or bound.` }),
  // After what is left for the agent: what comes next.
  next: {
    check: 'Then check the answers and click Looks right. Never Bind or Submit.',
    offSteps: 'Then moving on is yours: nothing on this step is clicked for you.',
    offList: 'Then click Continue yourself: this page isn’t one the extension continues on.',
    continueHere: 'Then click Continue on this page yourself. Nothing is submitted or bound.',
    manual: 'Then click Continue yourself, and Fill this page on the next one.',
    followUps: 'Then the panel continues to the next page. Never Bind or Submit.',
    fillAgain: 'Then Fill this page again to continue. Never Bind or Submit.',
  },
  filled: (filled) => `${filled} filled`,
  covered: { title: 'Close what is open over the button', sub: 'Then fill again. Never Binds or Submits.' },
  buttonsLeft: { title: 'Buttons left to click', sub: 'Continue clicks the ones it can in turn, and the page’s Continue once none is left. Never Bind or Submit.', continue: 'Continue', click: 'Click them for me' },
  needs: { eyebrow: (filled, left) => `${filled} filled · ${left} ${plural(left, 'needs', 'need')} you`,
    title: (left) => (left === 1 ? 'Answer the last question' : `Answer ${left} questions`), label: 'Show the next one' },
  changed: { eyebrow: 'The page changed', title: 'Check the answers again', sub: 'The page changed. Check it, then continue.' },
  check: { eyebrow: 'All answered', title: 'Look over the answers, then continue', sub: 'Never Binds or Submits.' },
  offSteps: { eyebrow: 'All answered', title: 'Moving on is yours', sub: 'Nothing here is clicked for you. Never Binds or Submits.' },
  offList: { eyebrow: 'All answered', title: 'Click Continue yourself', sub: 'This page isn’t one the extension continues on. Never Binds or Submits.' },
  ready: { eyebrow: 'All answered', title: 'Ready for Continue', sub: 'Never Binds or Submits.', label: 'Continue',
    continueHere: 'Click Continue on this page yourself. Never Binds or Submits.', manual: 'Click Continue, then fill the next page.' },
};

// The head of a page's report and what it announces (renderReport).
export const REPORT = {
  paused: 'Automatic filling and helpers paused. ',
  reviewFirst: 'Review this page before retrying.',
  noQuestions: 'No questions found on this page.',
  nothingToFill: 'Nothing to fill on this page.',
  // Buttons not clicked for something open over them (their words).
  covered: (names) => ({ title: `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} weren’t` : `${names[0]} wasn’t`} clicked`,
    text: `Close what is open over ${names.length > 1 ? 'them' : 'it'}, then fill again.` }),
  youStopped: { title: 'You stopped the fill', text: 'Nothing more was filled or clicked. What went in stays.' },
  fillStopped: (reason) => ({ title: 'Filling stopped', text: `${reason ?? ''} Check the page, then fill again.`.trim() }),
  // The carrier probably changed this page: `unknown` questions it doesn't know, `renamed` fields moved.
  pageChanged: (carrier, unknown, renamed) => ({ title: 'This page seems to have changed',
    text: `${carrier ?? 'The carrier'} seems to have changed this page: ${unknown} question(s) aren't known`
      + (renamed ? `, and ${renamed} moved to a field the extension doesn't know` : '')
      + ". They're left for you and Continue waits. Please report it (a Capture page layout helps)." }),
  continued: (count, button) => `${count} ${plural(count, 'answer')} in. Clicked “${button}” for you.`,
  // Said to screen readers once the report is drawn.
  announce: (count, left, held) => `Filled ${count} ${plural(count, 'answer')}. ${left ? `${left} left for you.` : held ? 'Check the answers, then click Looks right.' : 'Nothing is left for you.'}`,
};

// The intake's checks, above them (renderWarnings).
export const CHECKS = {
  title: (open) => (open ? `${open} to check on the intake` : 'Intake checked'),
  sub: (open) => (open ? 'Fix or confirm each one, before or after filling.' : 'Nothing else looked wrong.'),
  // An item's link to where the intake PDF shows it (`page`: its page, said).
  seeIntake: (page) => `See intake${page}`,
};

// Where an answer came from: its tag on the row (`text`, `title` on hover), and the title and quote
// its row opens to.
export const SOURCE = {
  tag: {
    intake: (page) => ({ text: `Intake${page ?? ''}`, title: 'From the intake' }),
    derived: { text: 'Worked out', title: 'Worked out from intake answers' },
    standard: { text: 'TNI standard', title: 'A TNI standard answer, not a fact from the intake' },
    own: { text: 'Your default', title: 'Your own default in place of TNI\'s standard (Settings → Your defaults)' },
    edited: { text: 'Your edit', title: 'From your correction in the panel' },
    pageStandard: { text: 'TNI standard', title: 'The page already had the TNI standard answer' },
    page: { text: 'On the page', title: 'The page already had it' },
    clicked: { text: 'Clicked', title: 'Clicked for you' },
    yours: { text: 'You', title: 'Your answer: no fill changes it' },
    changed: { text: 'Changed on the page', title: 'Not the fill’s answer: the page shows this now' },
  },
  // An intake value as a row quotes it.
  value: (v) => (v === true ? 'Yes' : v === false ? 'No' : v == null || v === '' ? 'not on the intake' : String(v)),
  answer: (value) => `Answer: ${value}`,
  open: {
    intake: (page) => `Intake${page ?? ''}`,
    derived: 'Worked out from the intake',
    standard: 'TNI standard answer',
    own: 'Your own default',
    ownQuote: (value) => `Answer: ${value}. In place of TNI's standard, from Settings → Your defaults.`,
    edited: 'Your correction in the panel',
    page: ['Already on the page', 'The fill left it as the page had it.'],
    clicked: 'Clicked for you',
    yours: ['Your answer', 'You changed it on the page, so no fill puts it back.'],
    changed: ['Changed on the page', 'The page shows this now, not the answer the fill put in. Check it.'],
  },
  see: { edited: 'Show what the intake said before your edit', derived: 'Show the intake answers this was worked out from', other: 'Show where this came from in the intake' },
};
