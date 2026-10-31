// The side panel's decision logic: whether a fill, or a layout job, is still the one the panel is
// showing (the intake, the tab and the page it was for), and how a fill's error is said. No DOM.
// One part of the panel; sidepanel.js wires the parts together.
import { redactionTerms } from '../../src/plan.js';
import { knownStep, redactor } from '../../src/usage.js';
import { state } from './core.js';

// The intake was replaced or corrected while the page was being filled: the answers on the page
// are the earlier intake's, and nothing from this fill may be remembered, logged or shown as the
// current intake's.
function staleFill(ctx) { return state.intake !== ctx.intake || state.intakeRevision !== ctx.revision; }

// Automatic work and panel reports belong only to the fill still shown in the panel.
function fillCurrent(ctx) { return !staleFill(ctx) && state.tab?.id === ctx.tabId; }

function superseded(job) {
  if (job.generation === undefined || job.generation === state.layoutGeneration) return false;
  const later = state.layoutLatest;
  if (job.reasons && later && later !== job && !later.done && sameLayoutScope(later, job)) job.reasons.forEach((r) => later.reasons.add(r));
  return true;
}

// A capture asked for by a page change is also dropped when a later change has been asked for
// since: this one would log the later state under the earlier answer. The latest capture reads
// the page after both and, until it's logged, takes this one's reasons. (A fill's own capture
// has no generation.)
function sameLayoutScope(a, b) {
  return ['session', 'tabId', 'page', 'active'].every((k) => a[k] === b[k]);
}

// What kind of failure, never its message: Chrome's and the page's errors can quote the page's
// address and values from it.
function layoutErrorKind(e) {
  const m = String(e?.message ?? e);
  if (/frame/i.test(m) && /removed|not found|no frame/i.test(m)) return 'frame gone';
  if (/no tab|tab\b.*\b(closed|not found)/i.test(m)) return 'tab gone';
  if (/cannot access|cannot be scripted|permission|not allowed/i.test(m)) return 'page not accessible';
  if (/__raterKit/.test(m)) return 'kit missing';
  return /^[A-Za-z]*Error$/.test(e?.name ?? '') ? `other ${e.name}` : 'other';
}

// A fill's error in words the agent can act on, with the browser's own message (redacted with the
// intake: it may quote the page) after it for a problem report.
function fillErrorMessage(ctx, e) {
  const raw = String(e?.message ?? e ?? '');
  const plain = /cannot access|permission|not allowed|cannot be scripted|chrome:\/\//i.test(raw)
    ? 'The browser blocked the extension on this page. Reload it, then fill again.'
    : /no tab with id|tab was closed/i.test(raw) ? 'The tab was closed during the fill.'
      : /frame|document|navigat|unload|back\/forward|receiving end/i.test(raw)
        ? 'The page changed or reloaded during the fill. Let it load, then fill again.'
        : 'Filling failed. Check the page, then fill again.';
  const detail = fillErrorText(ctx, e);
  return detail ? `${plain} (${detail})` : plain;
}

function fillErrorText(ctx, e) { return redactor(redactionTerms(ctx.intake.record))(String(e?.message ?? e)).slice(0, 200); }

// The step a one-address application (AmWINS) showed to the fill: the top frame's headings, sent
// only as one of the carrier's step names (knownStep).
function stepOfResults(carrier, results) { return knownStep(carrier, results.find((r) => r.frameId === 0)?.result?.stepKey); }

export { fillCurrent, fillErrorMessage, fillErrorText, layoutErrorKind, sameLayoutScope, staleFill, stepOfResults, superseded };
