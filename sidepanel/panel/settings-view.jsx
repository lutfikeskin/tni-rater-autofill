// Settings in React, over everything but the header: the agent's initials, the Filling switches, the
// AI's card and its key, the usage log, and Advanced (the test-run mark, the usage server, page
// captures and the developer recording). Drawn from what the panel says: the switches (state.switches,
// set by init and by the agent), renderAiSettings (state.ai, with state.keyFormOpen), renderUsage and
// renderHealth (state.usageCard, state.usageNote, state.health), render (state.testRun), renderSite
// (state.captureOff), captureSaid (state.captureStatus) and the developer recording (state.devrec).
// What its controls do is the panel's (`act`, wired in sidepanel.js). Also the footer's Recording
// usage line (state.recordingLine).
// The panel still reads each switch from its box by id (`$('auto-advance').checked`), and the text
// boxes are the agent's: the panel reads and writes their values by id, so the upload token and the
// AI key never go into the panel's state.
// One part of the panel; sidepanel.js mounts it (mountSettings, mountRecordingLine).
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

// A checkbox the panel reads by id. It shows `checked` whenever that changes, or whenever `said`
// (what it was said in) is said again, and the agent's click is passed on as the box's own change
// event says it (`onChange(checked)`), as the panel's listener took it before.
function Check({ checked, said, onChange, ...props }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (ref.current.checked !== checked) ref.current.checked = checked;
  }, [checked, said]);
  useEffect(() => {
    const box = ref.current;
    const changed = () => onChange(box.checked);
    box.addEventListener('change', changed);
    return () => box.removeEventListener('change', changed);
  }, [onChange]);
  return <input ref={ref} type="checkbox" {...props} />;
}

// A text box whose value the panel reads and writes by id; `onChange(value)` when the agent leaves it
// changed or presses Enter (its change event), not on each key.
function TextBox({ onChange, ...props }) {
  const ref = useRef(null);
  useEffect(() => {
    const box = ref.current;
    const changed = () => onChange(box.value);
    box.addEventListener('change', changed);
    return () => box.removeEventListener('change', changed);
  }, [onChange]);
  return <input ref={ref} {...props} />;
}

// A Filling switch, as a row: its name, what it does on hover, and the switch.
function SwitchRow({ id, name, title, rowId, sub, checked, said, disabled, onChange }) {
  return (
    <label id={rowId} className={`opt${sub ? ' sub' : ''}`} title={title}>
      <span className="opt-text"><b>{name}</b></span>
      <Check role="switch" className="switch" id={id} checked={checked} said={said} disabled={disabled} onChange={onChange} />
    </label>
  );
}

// The AI's card, folded under its row (the row says whether it's on). Opened by itself when AI is on
// without a key, so that warning isn't hidden, each time renderAiSettings says so. The key's box opens
// with Add key (or Change), and its key is put in and read from the box by the panel (openKeyForm,
// aiActs): never in the panel's state.
function Assistant({ act }) {
  const ai = useStore(panelStore, (s) => s.ai);
  const keyOpen = useStore(panelStore, (s) => !!s.keyFormOpen);
  const fold = useRef(null);
  useLayoutEffect(() => {
    if (ai?.warn) fold.current.open = true;
  }, [ai]);
  return (
    <details id="assistant" ref={fold} className="group fold">
      <summary className="list-row"><svg className="fold-icon" aria-hidden="true"><use href="#brain" /></svg><span className="fold-name">AI</span><span id="ai-note" className={ai?.noteTone}>{ai?.note ?? ''}</span><span className="chev" aria-hidden="true">›</span></summary>
      <div id="agent-card" className={`card${ai?.warn ? ' warn' : ''}`}>
        <label className="opt" title="For questions the intake doesn’t answer"><span className="opt-text"><b>Suggest answers</b></span><Check id="ai-on" role="switch" className="switch" checked={!!ai?.on} said={ai} onChange={act.aiOn} /></label>
        <label id="ai-auto-option" className="opt" title="Shown in purple. You still approve them before Continue." hidden={!!ai && !ai.autoShown}>
          <span className="opt-text"><b>Put checked picks in</b></span>
          <Check id="ai-auto" role="switch" className="switch" checked={!!ai?.auto} said={ai} disabled={!!ai?.autoOff} onChange={act.aiAuto} />
        </label>
        <div className="key-row">
          <div className="opt">
            <span className="opt-text"><b id="key-label">OpenAI key</b><span id="key-status" className={ai?.keyTone}>{ai?.keyStatus ?? ''}</span></span>
            <button type="button" id="key-edit" className="ghost small-btn" aria-controls="key-form" aria-expanded={keyOpen} onClick={() => act.keyEdit()}>{keyOpen ? 'Cancel' : ai?.keyEdit ?? 'Add key'}</button>
          </div>
          <div id="key-form" className="key-form" hidden={!keyOpen}>
            <input id="ai-openai-key" type="password" placeholder="Paste the key from your manager" autoComplete="off" aria-labelledby="key-label" onKeyDown={(e) => act.keyKey(e)} />
            <button type="button" id="key-save" className="primary small-btn" onClick={() => act.keySave()}>Save</button>
          </div>
        </div>
      </div>
    </details>
  );
}

// The developer recording's card (docs/developer-recording.md): unpacked builds only, which wire
// says by passing its actions (`devrec`; none in the store's builds).
function DevRecording({ act }) {
  const devrec = useStore(panelStore, (s) => s.devrec);
  const on = !!devrec?.on;
  const left = devrec?.unfinished;
  return (
    <div id="devrec" className="devrec" hidden={!act}>
      <p className="eyebrow">Developer recording</p>
      <p className="fine">{"Records this quote's clicks, keys, scrolling and page changes with their times, as one zip in Downloads. Nothing is uploaded. It records only the tab it starts on: start it on the quoting page itself. It uses the Scenario above; Note adds the Note box to the timeline."}</p>
      <div className="actions wrap">
        <button type="button" id="devrec-start" className="ghost small-btn" hidden={on} onClick={() => act?.start()}>Record this quote</button>
        <button type="button" id="devrec-note" className="ghost small-btn" hidden={!on} onClick={() => act?.note()}>Note</button>
        <button type="button" id="devrec-stop" className="ghost small-btn" hidden={!on} onClick={() => act?.stop()}>Stop and save</button>
        <button type="button" id="devrec-recover" className="ghost small-btn" hidden={!left} data-id={left?.id ?? ''} onClick={() => act?.recover()}>{left?.label ?? 'Save the unfinished recording'}</button>
      </div>
      <p id="devrec-status" className="fine" role="status" hidden={!devrec?.status}>{devrec?.status ?? ''}</p>
    </div>
  );
}

// `act`: done; the Filling switches (switch(name, on)); agent, serverUrl, serverToken (a box's new
// value); upload, exportLog, clearLog, capture; testRun(on); the AI's aiOn(on), aiAuto(on), keyEdit,
// keySave and keyKey (a key pressed in the key's box); and the developer recording's (devrec: start,
// note, stop, recover), or null where it isn't offered.
function Settings({ act }) {
  const switches = useStore(panelStore, (s) => s.switches) ?? {};
  const health = useStore(panelStore, (s) => s.health);
  const card = useStore(panelStore, (s) => s.usageCard);
  const note = useStore(panelStore, (s) => s.usageNote);
  const testRun = useStore(panelStore, (s) => s.testRun);
  const captureOff = useStore(panelStore, (s) => !!s.captureOff);
  const captureStatus = useStore(panelStore, (s) => s.captureStatus);
  const recording = useStore(panelStore, (s) => !!s.devrec?.on);
  const flip = (name) => (on) => act.switch(name, on);
  return (
    <>
      <div className="settings-head">
        <h2>Settings</h2>
        <button type="button" id="settings-done" className="primary small-btn" onClick={() => act.done()}>Done</button>
      </div>
      <div id="setup-note" className="setup-note" role="status" hidden={!health?.setup}><span className="bang" aria-hidden="true">!</span><span id="setup-text">{health?.setup ?? ''}</span></div>

      <div className="group">
        <div className="eyebrow">You</div>
        <div className="card">
          <label className="opt" title="So your quotes count as yours"><span className="opt-text"><b>Your initials</b></span><TextBox id="agent" className={health?.agentMissing ? 'missing' : undefined} type="text" maxLength={6} autoComplete="off" placeholder="e.g. JK" onChange={act.agent} /></label>
        </div>
      </div>

      <div className="group">
        <div className="eyebrow">Filling</div>
        <div className="card">
          <SwitchRow id="auto-pages" name="Fill pages when they open" title="You won’t need to press Fill this page" checked={switches.autoPages !== false} said={switches} onChange={flip('autoPages')} />
          <SwitchRow id="auto-followups" name="Fill follow-up questions" title="Some answers open more questions" checked={switches.autoFollowUps !== false} said={switches} onChange={flip('autoFollowUps')} />
          <SwitchRow id="auto-advance" name="Continue when the page is done" title="Only when nothing is left for you" checked={switches.autoAdvance !== false} said={switches} onChange={flip('autoAdvance')} />
          {/* "Let me look first" is about the panel's Continue: off with it. */}
          <SwitchRow id="check-continue" rowId="check-continue-row" sub name="Let me look first" title="Waits for you to press Looks right, continue" checked={switches.checkBeforeContinue !== false}
            disabled={switches.autoAdvance === false} said={switches} onChange={flip('checkBeforeContinue')} />
          <SwitchRow id="overwrite" name="Replace prefilled answers" title="Off keeps what the rater filled itself, like a DOT lookup" checked={!!switches.overwrite} said={switches} onChange={flip('overwrite')} />
          <SwitchRow id="finish-sound" name="Sound when the quote is done" checked={switches.finishSound !== false} said={switches} onChange={flip('finishSound')} />
        </div>
        <p className="fine">Never Binds or Submits.</p>
      </div>

      <Assistant act={act} />

      <div className="group">
        <div className="eyebrow">Usage log</div>
        <div id="usage" className="card padded">
          <p id="upload-status" className={`status-line${card?.uploadTone ? ` ${card.uploadTone}` : ''}`}>{card?.upload ?? ''}</p>
          <p className="fine">{"How the panel is used, and each client's business profile. No names, numbers or addresses."}</p>
          <p id="usage-count" className="fine">{card?.count ?? ''}</p>
          <p id="usage-note" className="fine" aria-live="polite">{note ?? ''}</p>
        </div>
      </div>

      <details id="advanced" className="advanced">
        <summary className="eyebrow">{recording ? 'Advanced, for setup only · Recording' : 'Advanced, for setup only'}</summary>
        <div className="advanced-body">
          {/* For the maintainer's practice quotes; agents don't see it unless they open Advanced. Marking a test run needs an intake to mark. */}
          <label id="test-run-row" className="test-run" title="A practice or test quote, not a client's: the weekly review leaves it out of its numbers." hidden={testRun == null}><Check id="test-run" checked={!!testRun} onChange={act.testRun} /> This intake is a test run, not a client</label>
          <label className="field-stack">Server<TextBox id="server-url" type="url" placeholder="https://usage-server-production.up.railway.app" autoComplete="off" onChange={act.serverUrl} /></label>
          <label className="field-stack">Token<TextBox id="server-token" type="password" placeholder="if the server needs one" autoComplete="off" onChange={act.serverToken} /></label>
          <label className="field-stack">Scenario<input id="capture-scenario" type="text" placeholder="e.g. FL van, hazmat yes/no" autoComplete="off" maxLength={60} /></label>
          <label className="field-stack">Note<input id="capture-note" type="text" placeholder="what you changed (kept here)" autoComplete="off" maxLength={200} /></label>
          <div className="actions wrap">
            <button type="button" id="capture" className="ghost small-btn" title="Alt+Shift+C while the panel is open" disabled={captureOff} onClick={() => act.capture()}>Capture page layout</button>
            <button type="button" id="upload-usage" className="ghost small-btn" onClick={() => act.upload()}>Upload now</button>
            <button type="button" id="export-usage" className="ghost small-btn" onClick={() => act.exportLog()}>Export log</button>
            <button type="button" id="clear-usage" className="ghost small-btn danger" onClick={() => act.clearLog()}>Clear log</button>
          </div>
          <p id="capture-status" className="fine" role="status" hidden={!captureStatus}>{captureStatus ?? ''}</p>
          <DevRecording act={act.devrec} />
        </div>
      </details>
      <p id="version" className="eyebrow">{health?.version ?? ''}</p>
    </>
  );
}

// The footer's "Recording usage": while an intake is loaded, except on a practice page (render,
// renderSite, renderUsage say it: state.recordingLine).
function RecordingLine() {
  const on = useStore(panelStore, (s) => !!s.recordingLine);
  return <span id="recording" className="recording" title="Usage is recorded, never client information. See Settings." hidden={!on}><span className="rec-dot">●</span> Recording usage</span>;
}

// Draws Settings into #settings, before it returns (showScreen shows or hides it).
function mountSettings(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<Settings act={act} />));
}

// Draws the footer's Recording usage line into #recording-root, before it returns.
function mountRecordingLine(host) {
  const root = createRoot(host);
  flushSync(() => root.render(<RecordingLine />));
}

export { mountRecordingLine, mountSettings, RecordingLine, Settings };
