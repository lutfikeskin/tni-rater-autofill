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
import { announce, issueCard, renderSite, renderSteps, unlockAudio } from './coordinator.js';
import { aiSettings, renderAiSettings } from './assistant.js';

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
  $('notices').replaceChildren(...(saved.state === 'error' ? [issueCard({ tone: 'warn', role: 'alert', title: "Usage log can't be saved on this computer",
    text: `Nothing is recorded now (${saved.message}). Export the log (Settings, Advanced) and tell TNI.` })] : []));
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
      await usage.saveSettings({ agent: value.trim().toUpperCase().slice(0, 6) || null });
      renderUsage();
    },
    exportLog: async () => {
      const n = await usage.exportLog();
      state.usageNote = `Exported ${n} events to your Downloads.`;
      renderUsage();
    },
    clearLog: async () => {
      const { lastExportCount = 0 } = await usage.settings();
      const n = await usage.count();
      const msg = n > lastExportCount
        ? `${n} events aren't uploaded or exported. Delete them anyway?`
        : `Delete the ${n} exported events from this computer?`;
      if (!confirm(msg)) return;
      await usage.clearLog();
      state.usageNote = 'Usage log cleared.';
      renderUsage();
    },
  };
}

function wireUsage() {
  document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
  setInterval(uploadNow, 60_000);
  // Report a problem opens its box above the footer, and says so (aria-expanded).
  const problemOpen = (open) => { $('problem-form').hidden = !open; $('report-problem').setAttribute('aria-expanded', String(open)); };
  $('report-problem').addEventListener('click', () => {
    problemOpen($('problem-form').hidden);
    if (!$('problem-form').hidden) $('problem-text').focus();
  });
  $('cancel-problem').addEventListener('click', () => { $('problem-text').value = ''; problemOpen(false); $('report-problem').focus(); });
  $('send-problem').addEventListener('click', () => {
    const text = $('problem-text').value.trim();
    if (!text) return;
    const redact = state.intake ? redactor(redactionTerms(state.intake.record)) : (x) => x;
    const page = state.tab?.url ? pageOf(state.tab.url) : null;
    usage.log({ type: 'problem_report', carrier: state.tab?.carrier?.id ?? null, page, text: redact(text).slice(0, 1000), ...problemContext(state.tab, page) });
    $('problem-text').value = '';
    problemOpen(false);
    announce('Thanks — saved with the usage log.');
    state.usageNote = 'Thanks — saved with the usage log.';
    // Sent now rather than on the minute: the panel is often closed right after (audit 2026-10-08).
    uploadNow();
  });
  setInterval(renderUsage, 5000);
}

export { renderUsage, settingsActs, uploadNow, wireUsage };
