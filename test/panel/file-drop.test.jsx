import { beforeEach, expect, test } from 'vitest';
import { fileReplacer } from '../../sidepanel/panel/file-drop.js';

// Audit 2026-11-07, UX-01: a PDF dropped anywhere on the panel replaced the client at once, with no
// question even when the agent had corrected or checked this intake, and even while answers went
// in. A drop now goes the way Change file does (the same question, under the client's name), and
// one while answers go in is refused: Stop first.

const workSaid = (edits, checks) => [edits ? `corrected ${edits} answer${edits === 1 ? '' : 's'}` : null,
  checks ? `checked ${checks} item${checks === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');

let state, calls, replacing;
beforeEach(() => {
  state = { filling: false, resetting: false, closing: false, intake: null };
  calls = [];
  replacing = fileReplacer({ state, load: (file) => calls.push(['load', file.name]), pick: () => calls.push(['pick']),
    ask: (text, yes) => calls.push(['ask', text, yes]), note: (text) => calls.push(['note', text]), work: workSaid });
});
const pdf = (name) => /** @type {File} */ ({ name });

test('a PDF dropped with nothing done on this intake (or none loaded) is loaded, as Change file opens the picker', () => {
  replacing.replace(pdf('first.pdf'));
  state.intake = { agentEdited: [], done: [] };
  replacing.replace(pdf('second.pdf'));
  replacing.replace();
  expect(calls).toEqual([['load', 'first.pdf'], ['load', 'second.pdf'], ['pick']]);
});

test('once the agent corrected or checked this intake, a PDF dropped asks Change file\'s question, and loads only on Yes', () => {
  state.intake = { agentEdited: ['applicant.name', 'drivers[0].dob'], done: [3] };
  replacing.replace(pdf('next.pdf'));
  expect(calls).toEqual([['ask', 'You corrected 2 answers and checked 1 item. A different file starts over; the same file keeps it.', 'Use this file']]);
  replacing.answered(true);
  expect(calls.slice(1)).toEqual([['load', 'next.pdf']]);
  // Cancel forgets it: a later Yes (Change file's own) opens the picker, never the PDF dropped.
  calls.length = 0;
  replacing.replace(pdf('next.pdf'));
  replacing.answered(false);
  replacing.replace();
  replacing.answered(true);
  expect(calls.map((c) => c[0])).toEqual(['ask', 'ask', 'pick']);
  expect(calls[1]).toEqual(['ask', 'You corrected 2 answers and checked 1 item. A different file starts over; the same file keeps it.', 'Choose a file']);
});

test('a PDF dropped while answers go in is refused with a note, and so is a Yes given once a fill began', () => {
  state.intake = { agentEdited: [], done: [] };
  for (const busy of ['filling', 'resetting', 'closing']) {
    state[busy] = true;
    replacing.replace(pdf('next.pdf'));
    state[busy] = false;
  }
  expect(calls).toEqual(Array(3).fill(['note', 'Answers are going in. Stop the fill, then drop the file again.']));
  // Asked before the fill began, answered after: still refused, and the PDF is let go.
  calls.length = 0;
  state.intake = { agentEdited: ['applicant.name'], done: [] };
  replacing.replace(pdf('next.pdf'));
  state.filling = true;
  replacing.answered(true);
  state.filling = false;
  replacing.answered(true);
  expect(calls.map((c) => c[0])).toEqual(['ask', 'note', 'pick']);
  // Change file itself isn't refused: only a PDF dropped is.
  calls.length = 0;
  state.filling = true;
  state.intake = { agentEdited: [], done: [] };
  replacing.replace();
  expect(calls).toEqual([['pick']]);
});
