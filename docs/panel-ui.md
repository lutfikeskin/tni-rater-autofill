# Panel UI

Read this when a change adds or alters what the side panel draws: a view (`sidepanel/panel/*-view.jsx`), its markup in `sidepanel/sidepanel.html`, or `sidepanel/sidepanel.css`. It holds the rules every view follows so that an agent using a keyboard or a screen reader gets what a mouse user gets. What the panel shows and when is in [Browser filling](browser-filling.md#review-and-navigation); how its views are tested is in [Testing](testing.md).

Several of these rules come from comparing the panel with [vercel-labs/ui](https://github.com/vercel-labs/ui) (UI SDK, a library of keyboard, focus and ARIA behaviors, 2026-11). The panel doesn't ship that library; it keeps its own views and styles and follows the same rules.

## Saying what changed

A screen reader reads a live region (`role="status"`, `aria-live`) when its words change, but often not when the region itself is shown, or put on the page, at the moment its words go in. So the panel has one live region, `#announce` in `sidepanel.html` (`role="status"`, `aria-live="polite"`, visually hidden, never `hidden`), and everything it says goes there:

- Plain code calls `announce(text)` from [announce.js](../sidepanel/panel/announce.js) (`coordinator.js` imports it for the rest of the panel). It empties the region and fills it a moment later (`ANNOUNCE_MS`), so the same words said again are read again; words said in that moment are read together, in order, each once, instead of the last replacing the others.
- A note in a React view that shows and hides (`hidden={!text}`) has no live role of its own. It calls `useAnnounce(text, ref)` with a ref to its element, which says the words each time they change to new words, unless the note is inside a hidden part of the panel (Settings closed, a sheet not open). Today these are the client's note (`#client-note`), the dock's paused line (`#dock-paused`), the quote summary's saved line (`#summary-saved`), Settings' setup note (`#setup-note`), its note while answers go in (`#filling-now-note`), the capture status (`#capture-status`) and the developer recording's status (`#devrec-status`); the footer's line about a problem report (`#problem-said`, `sayProblem` in `usage-panel.js`) calls `announce` itself.
- A line that is always on the page and only changes its words can keep `aria-live` (Settings' usage note, `#usage-note`).
- A card that must interrupt (a fill that stopped, a PDF that can't be read) keeps `role="alert"`.

Don't add `role="status"` to an element that is drawn hidden or mounted with its words; use `useAnnounce` instead. `test/panel/announce.test.jsx` checks the region's timing and the hook. The issue cards drawn by `cards-view.jsx` and `notes-view.jsx` still take `role="status"` from their card's `role` as they are put on the page; moving them to `announce` is a change of its own.
