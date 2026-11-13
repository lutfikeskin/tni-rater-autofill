// @ts-check
// What the panel says to screen readers, through one live region that is always on the page
// (#announce in sidepanel.html: role="status", aria-live="polite"). A region that is hidden, or put on
// the page, as its words go in is often not read at all, so a note that shows and hides (the client's
// note, Settings' notes, the dock's paused line, the quote summary's saved line, the footer's report
// line) carries no live role of its own and says its words here as it shows them (`useAnnounce`, or
// `announce` from plain code). Docs: docs/panel-ui.md.
import { useEffect, useRef } from 'react';

// Said within ANNOUNCE_MS of each other, words are read together, in order, each once: the region
// keeps only its last words, so a second announce in the same moment would replace the first.
const ANNOUNCE_MS = 50;
/** @type {string[]} */
let pending = [];
/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null;

// Says `text` politely. The region is emptied first and filled a moment later, so the same words
// said again are read again.
function announce(text) {
  const live = document.getElementById('announce');
  if (!live || !text) return;
  if (!pending.includes(text)) pending.push(text);
  if (timer) return;
  live.textContent = '';
  timer = setTimeout(() => {
    live.textContent = pending.join(' ');
    pending = [];
    timer = null;
  }, ANNOUNCE_MS);
}

// A React view's note that shows and hides: says `text` each time it changes to words, while the
// note (`ref`, the element showing it) isn't in a hidden part of the panel (Settings closed, a sheet
// not open). Nothing is said for words already shown when the view is drawn again.
/** @param {string | null | undefined} text @param {{ current: Element | null }} ref */
function useAnnounce(text, ref) {
  const last = useRef('');
  useEffect(() => {
    const said = text || '';
    if (said && said !== last.current && !ref.current?.closest('[hidden]')) announce(said);
    last.current = said;
  }, [text, ref]);
}

export { ANNOUNCE_MS, announce, useAnnounce };
