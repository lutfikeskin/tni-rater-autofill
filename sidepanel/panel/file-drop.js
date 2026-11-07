// @ts-check
// The side panel: another intake PDF, from Change file or dropped anywhere on the panel. Both go
// the same way: with nothing done on this intake the file is loaded (Change file opens the file
// picker); once the agent has corrected or checked anything, Change file's question asks first
// (a different file starts over; the same file keeps the work), and a dropped PDF is kept until
// it is answered. A PDF dropped while answers go in (or while the panel is starting a new quote,
// clearing the client or giving way to another copy) is refused with a note: Stop first.
// One part of the panel; sidepanel.js wires it to the panel's own parts (`panel`).

/**
 * @typedef {object} ReplacePanel
 * @property {{ filling?: boolean, resetting?: boolean, closing?: boolean, intake?: any }} state the panel's state
 * @property {(file: File) => unknown} load loads an intake PDF (loadFile)
 * @property {() => void} pick opens the file picker
 * @property {(text: string, yes: string) => void} ask Change file's question under the client's name (askFile 'replace')
 * @property {(text: string) => void} note the line under the client's name (clientNote)
 * @property {(edits: number, checks: number) => string} work what the agent did on this intake (workSaid)
 */

const BUSY = 'Answers are going in. Stop the fill, then drop the file again.';

/** @param {ReplacePanel} panel */
function fileReplacer(panel) {
  /** @type {File | null} */
  let kept = null;
  const { state } = panel;
  const busy = () => !!(state.filling || state.resetting || state.closing);
  return {
    // Change file (no `file`), or a PDF dropped on the panel (`file`).
    /** @param {File | null} [file] */
    replace(file = null) {
      kept = null;
      if (file && busy()) { panel.note(BUSY); return; }
      const work = state.intake ? panel.work(state.intake.agentEdited?.length ?? 0, state.intake.done?.length ?? 0) : '';
      if (!work) { if (file) panel.load(file); else panel.pick(); return; }
      kept = file;
      panel.ask(`You ${work}. A different file starts over; the same file keeps it.`, file ? 'Use this file' : 'Choose a file');
    },
    // Change file's question answered: Yes loads the PDF dropped (still refused while answers go
    // in), else opens the file picker; Cancel forgets the PDF dropped.
    /** @param {boolean} yes */
    answered(yes) {
      const file = kept;
      kept = null;
      if (!yes) return;
      if (!file) { panel.pick(); return; }
      if (busy()) { panel.note(BUSY); return; }
      panel.load(file);
    },
  };
}

export { fileReplacer };
