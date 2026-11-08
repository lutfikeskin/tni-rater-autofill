// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
// The side panel: the usage log panel and problem reports.
// One part of the panel; sidepanel.js wires the parts together.
import { redactionTerms } from '../../src/plan.js';
import { redactor } from '../../src/usage.js';
import * as usage from '../usage-log.js';
import { PROVIDERS } from '../../src/ai/providers.js';
import { inExtension } from './env.js';
import { $, state } from './core.js';
import { logSettings, problemContext } from './intake.js';
import { pageOf } from './usage.js';
import { announce, issueSaid, renderSite, renderSteps, unlockAudio } from './coordinator.js';
import { aiSettings, renderAiSettings } from './assistant.js';
import { initialsChanged } from './agent-defaults/store.js';
import { markSwitch } from './tab-mark.js';

// ---------------------------------------------------------------------------------------------
// Usage log panel and problem reports

// The usage card in Settings, said as data (state.usageCard; settings-view.jsx draws it): how many
// events wait here, and the last upload, in its tone.
async function renderUsage() {
  const n = await usage.count();
  const { agent = '', serverToken = '' } = await usage.settings();
  const { serverUrl } = await usage.serverConfig();
  const up = usage.lastUpload();
  const when = up.at ? new Date(up.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  state.usageCard = {
    count: (n
      ? `${n.toLocaleString()} event${n === 1 ? '' : 's'} waiting on this computer.`
      : 'Nothing waiting on this computer.')
      + (state.layoutErrors ? ` ${state.layoutErrors} page layout${state.layoutErrors === 1 ? '' : 's'} couldn't be read (logged).` : ''),
    upload: {
      ok: `Uploaded to the server at ${when}.`,
      error: `Upload failed at ${when}: ${up.message}. Saved here and retried every minute.`,
      off: 'No server set. Use Export log to hand it in.',
      idle: serverUrl ? `Uploads to ${serverUrl} every minute.` : '',
    }[up.state] ?? '',
    uploadTone: up.state === 'ok' ? 'ok' : up.state === 'error' || up.state === 'off' ? 'warn' : '',
  };
  // The boxes are the agent's: what is saved is put in them by id, unless they are typing there (the
  // token never goes into the panel's state).
  for (const [id, v] of [['agent', agent], ['server-url', serverUrl], ['server-token', serverToken]]) {
    if (document.activeElement !== $(id)) $(id).value = v;
  }
  state.recordingLine = !!state.intake && !state.tab?.carrier?.practice;
  renderHealth({ n, agent, serverUrl, up });
}

// The version this browser is running, and setup problems that otherwise go unnoticed until a
// review shows missing data: no initials, no AI key, no usage server (said in Settings, with a dot
// on its button), and a usage log that can't be saved (said on the main screen: nothing is recorded).
async function renderHealth({ up }) {
  const version = inExtension ? chrome.runtime.getManifest().version : 'dev';
  $('foot-version').textContent = `v${version}`;
  const { agent = '' } = await usage.settings();
  const ai = await aiSettings();
  const setup = [
    !agent && 'add your initials',
    ai.on && !ai.ready && `add the ${PROVIDERS[ai.provider].keyLabel}`,
    up.state === 'off' && 'set the usage server (Advanced)',
  ].filter(Boolean);
  // Said in Settings as data (state.health; settings-view.jsx): the version, the setup note (null:
  // none) and the initials' box marked while empty.
  state.health = { version: `Version ${version}`, setup: setup.length ? `To finish setup, ${joinAnd(setup)}.` : null, agentMissing: !agent };
  $('settings-dot').hidden = !setup.length;
  // Events that can't even be saved here are lost: that is said where the agent works.
  const saved = usage.lastSave();
  state.notes = { ...state.notes, usage: saved.state === 'error' ? issueSaid({ tone: 'warn', role: 'alert', title: "Usage log can't be saved on this computer",
    text: `Nothing is recorded now (${saved.message}). Export the log (Settings, Advanced) and tell TNI.` }) : null };
}

// "a", "a and b", "a, b and c".
function joinAnd(list) {
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] ?? '';
}

async function uploadNow() {
  await usage.upload();
  renderUsage();
}

// What Settings' switches, boxes and usage buttons do (settings-view.jsx asks for them: sidepanel.js
// passes these in its `act`). A box's value is its change event's, as before.
function settingsActs() {
  const switches = {
    autoFollowUps: async (on) => { await usage.saveSettings({ autoFollowUps: on }); logSettings('changed', 'autoFollowUps'); },
    autoPages: async (on) => { await usage.saveSettings({ autoPages: on }); logSettings('changed', 'autoPages'); },
    autoAdvance: async (on) => { const saving = usage.saveSettings({ autoAdvance: on }); renderSite(); await saving; logSettings('changed', 'autoAdvance'); },
    overwrite: () => logSettings('changed', 'overwrite'),
    // Saved with the other switches but never logged (fillContext's settings are the four the
    // usage server knows). The dock follows it (Looks right, continue).
    checkBeforeContinue: (on) => { usage.saveSettings({ checkBeforeContinue: on }); renderSteps(); },
    // Saved, never logged, like the one above. The chime needs a click in the panel first (unlockAudio).
    finishSound: (on) => { usage.saveSettings({ finishSound: on }); },
    // Not saved: on while the extension has the optional tabGroups permission, which Chrome asks the
    // agent for here (tab-mark.js). Never logged.
    markTab: (on) => markSwitch(on),
  };
  // Clear log's question, with the count it names (`n`).
  const askClearLog = async () => {
    const { lastExportCount = 0 } = await usage.settings();
    const n = await usage.count();
    state.usageAsk = n > lastExportCount
      ? { n, text: `${n} events aren't uploaded or exported. Delete them anyway?`, yes: 'Delete them' }
      : { n, text: `Delete the ${n} exported events from this computer?`, yes: 'Delete' };
  };
  return {
    // A Filling switch: what Settings draws follows it at once (Let me look first is off with
    // Continue when the page is done); the panel reads the switch from its box.
    switch: (name, on) => { state.switches = { ...state.switches, [name]: on }; return switches[name](on); },
    serverUrl: async (value) => {
      const v = value.trim();
      // Blank means "no server" (export only); anything else must be an http(s) URL.
      if (v && !/^https?:\/\/[^\s]+$/i.test(v)) { state.usageNote = 'Server must look like http://host:port'; return; }
      await usage.saveSettings({ serverUrl: v });
      uploadNow();
      // Without a key of the agent's own, Luna goes through this server (settingsFrom).
      renderAiSettings();
    },
    serverToken: async (value) => { await usage.saveSettings({ serverToken: value.trim() }); uploadNow(); renderAiSettings(); },
    upload: () => uploadNow(),
    agent: async (value) => {
      const initials = value.trim().toUpperCase().slice(0, 6) || null;
      await usage.saveSettings({ agent: initials });
      // agent defaults: new initials, no active profile until one is picked again.
      await initialsChanged(initials);
      renderUsage();
    },
    exportLog: async () => {
      const n = await usage.exportLog();
      state.usageNote = `Exported ${n} events to your Downloads.`;
      renderUsage();
    },
    // Clear log asks first, in the panel under its button (state.usageAsk, as the client's file tools
    // ask: askFile), never with a browser dialog, which would hold the panel and a fill's Stop while open.
    clearLog: () => askClearLog(),
    // A yes deletes what the question named: the log checks the count it asked about (`n`) under its
    // lock as it deletes (usage.clearLog `expected`), and events logged since are asked about again,
    // with the new count, instead.
    clearLogYes: async () => {
      const asked = state.usageAsk;
      if (!asked) return;
      if (!await usage.clearLog({ expected: asked.n })) { await askClearLog(); return; }
      state.usageAsk = null;
      state.usageNote = 'Usage log cleared.';
      renderUsage();
    },
    clearLogNo: () => { state.usageAsk = null; },
  };
}

// What the footer says once a problem report is saved (audit 2026-11-07, UX-11: the box closed with
// no word but the screen reader's): whether it reached TNI, by where the report itself is after the
// upload right after it (`fate`: usage.eventFate, `sent` only once the server confirmed it), with
// the upload's status for why it waits (`off`: no server), and whether the page's last fill goes with
// it (`withFill`: problemContext found one). `at`: the time to say.
function problemSaid(fate, status, withFill, at = new Date()) {
  const fill = withFill ? ", with this page's last fill" : '';
  if (fate === 'sent') return `Report saved and sent to TNI at ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${fill}.`;
  if (fate === 'refused') return `Report saved on this computer${fill}, but the usage server didn't take it: it stays here, and goes with Export.`;
  if (fate === 'unknown') return `Report saved${fill}. Whether it reached TNI couldn't be confirmed.`;
  if (status?.state === 'off') return `Report saved on this computer${fill}. No usage server is set, so it isn't sent.`;
  return `Report saved on this computer${fill}. It goes to TNI with the next upload.`;
}
// The footer's line about the report just saved, for a while (PROBLEM_SAID_MS), and gone when the box
// opens again.
const PROBLEM_SAID_MS = 10_000;
let problemSaidTimer = null;
// Counts the box opened and the reports saved: a report's upload that ends after either says nothing.
let problemRun = 0;
function sayProblem(text) {
  clearTimeout(problemSaidTimer);
  const line = $('problem-said');
  if (!line) return;
  line.textContent = text ?? '';
  line.hidden = !text;
  if (text) problemSaidTimer = setTimeout(() => sayProblem(null), PROBLEM_SAID_MS);
}

function wireUsage() {
  document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
  setInterval(uploadNow, 60_000);
  // Report a problem opens its box above the footer, and says so (aria-expanded).
  const problemOpen = (open) => { $('problem-form').hidden = !open; $('report-problem').setAttribute('aria-expanded', String(open)); };
  $('report-problem').addEventListener('click', () => {
    problemRun++;
    sayProblem(null);
    problemOpen($('problem-form').hidden);
    if (!$('problem-form').hidden) $('problem-text').focus();
  });
  $('cancel-problem').addEventListener('click', () => { $('problem-text').value = ''; problemOpen(false); $('report-problem').focus(); });
  $('send-problem').addEventListener('click', async () => {
    const text = $('problem-text').value.trim();
    if (!text) return;
    const redact = state.intake ? redactor(redactionTerms(state.intake.record)) : (x) => x;
    const page = state.tab?.url ? pageOf(state.tab.url) : null;
    const context = problemContext(state.tab, page);
    const run = ++problemRun;
    // Its own id, to say where it is once uploaded (usage.eventFate).
    const id = crypto.randomUUID();
    $('send-problem').disabled = true;
    await usage.log({ id, type: 'problem_report', carrier: state.tab?.carrier?.id ?? null, page, text: redact(text).slice(0, 1000), ...context });
    $('send-problem').disabled = false;
    // The box opened again meanwhile: what the agent types there is theirs, and this report goes
    // without a word.
    const current = () => run === problemRun;
    // Not saved (storage full, say): said, and the text stays in the box to try again or copy.
    if (usage.lastSave().state === 'error') { if (current()) sayProblem("The report couldn't be saved on this computer. Copy it, then try again."); return; }
    if (current()) {
      $('problem-text').value = '';
      problemOpen(false);
      announce('Thanks — saved with the usage log.');
      state.usageNote = 'Thanks — saved with the usage log.';
      sayProblem('Report saved. Sending it to TNI…');
    }
    // Sent now rather than on the minute: the panel is often closed right after (audit 2026-10-08).
    await uploadNow();
    // Said in the footer, where the box was, as this report went (and to a screen reader,
    // role=status), unless the box opened again or another report was saved meanwhile. Where it is
    // can't be read: not known.
    const fate = await usage.eventFate(id).catch(() => 'unknown');
    if (current()) sayProblem(problemSaid(fate, usage.lastUpload(), !!context.run));
  });
  setInterval(renderUsage, 5000);
}

export { problemSaid, renderUsage, settingsActs, uploadNow, wireUsage };
