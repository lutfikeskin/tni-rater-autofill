// GEICO's buttons, pressed from the page's own world (W43-44, FL, 2026-10-22). GEICO's submit
// buttons (Recalculate, Next, Save and Continue, Print Quote Proposal) set their own part of the
// request (the button's entry and its processor) after an await, and the page's React (18) applies
// it before the request is built only while an event is still being dispatched when that await
// resumes: during a mouse click, never after a script's click. The fill's Recalculate went out
// without it (171 entries, the agent's 172) and was rated with GEICO's own liability, UM,
// heavy-vehicle road service and cargo, though it carried the fill's values.
//
// The kit (pagekit.js pressButton) asks with a `rater-press` event on the button, which this takes
// (preventDefault). The click is made a moment later inside an event the browser itself dispatches
// (the volume change of an audio element never added to the page), so an event is being
// dispatched when the button's await resumes, as with a mouse click. `rater-pressed` on the button
// once clicked; if that event never comes, clicked after a second anyway and `rater-pressed-late`.
// Injected by the side panel for carriers with `pressInPage` (GEICO), in every frame, before each
// fill; a copy injected again (another build after an update) replaces the one before.
(() => {
  window.__raterPress?.off?.();
  const LATE_MS = 1000;
  const onPress = (e) => {
    const el = e.composedPath?.()[0] ?? e.target;
    if (typeof el?.click !== 'function') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    let done = false;
    const press = (late) => {
      if (done) return;
      done = true;
      try {
        el.click();
      } finally {
        el.dispatchEvent(new CustomEvent(late ? 'rater-pressed-late' : 'rater-pressed'));
      }
    };
    const media = document.createElement('audio');
    media.addEventListener('volumechange', () => press(false), { once: true });
    media.volume = 0;
    setTimeout(() => press(true), LATE_MS);
  };
  document.addEventListener('rater-press', onPress, true);
  window.__raterPress = { off: () => document.removeEventListener('rater-press', onPress, true) };
})();
