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

## Over the panel

Four things cover part of the panel: the PDF sheet, the quote summary and client details (sheets, `role="dialog"` with `aria-modal="true"`), and Settings, which covers the view but leaves the header in use. The keyboard over them is one function, `overlayKey` in [overlay-keys.js](../sidepanel/panel/overlay-keys.js), which `sidepanel.js` calls on every keydown with the layers in that order:

- Escape closes the topmost layer open, and only that one, through the panel's own close (`closePdf`, `closeSummary`, `closeDetails`, `closeSettings`), which gives focus back to the button that opened it.
- Tab and Shift+Tab stay inside an open sheet, wrapping at its ends; Tab from outside it goes to its first stop. The stops are links, enabled buttons and boxes, `summary` and elements with a `tabindex`, that are shown (`checkVisibility`). Settings isn't modal: Tab leaves it as it would anywhere.
- Opening a sheet moves focus into it (`openDetails`, `openSummary`, `openPdf`). Opening Settings leaves focus on its button, which says `aria-expanded="true"`; the next Tab goes into it.
- Settings closed with focus inside it gives focus back to `#settings-btn`, however it closed: Done, Escape, its button (`closeSettings`), or a new intake loaded while it was open (`showScreen`).

A new layer goes into that list in `sidepanel.js`, at its place in the order, with its own close that gives focus back. `test/panel/overlay-keys.test.jsx` and the safety tests check this.

## Names

Every control a keyboard or screen-reader user can reach has an accessible name: its own text, its `<label>`, or `aria-label` on a button that shows only an icon (the header's Settings, the client strip's tools, a sheet's Close). A name says what the control does where it sits, and two controls side by side don't share one: Change file and New quote with this intake, not two "Intake" buttons. `test/panel/control-names.test.jsx` asks Testing Library for a nameless control of every interactive role in `sidepanel.html` (with the quote and the problem form shown) and in each view; one drawn hidden isn't asked.

## Lists

A list whose items can change while it is on screen is keyed by what each item is, never by its place: a card's buttons by their label, a suggestion's rules by their text, a report's rows by their record, the live list by its field. Keyed by place, an item that goes away hands its node, with the agent's focus or an open fold, to the item after it. A list drawn once and never changed (a report's head, an `<option>` list whose value is its place) may use its place. `test/panel/cards-view.test.jsx` checks that a card said again without one of its buttons keeps focus on the button the agent was on.

## Motion

With the system's reduced-motion setting on, nothing in the panel slides, spins or fades: one rule at the end of `sidepanel.css` turns off every animation and transition, on elements and on their `::before` and `::after` content, and the fill's bar and spinner change to a steady full bar and a still "…" so they don't read as stuck. Scrolling the panel does it too: every `scrollIntoView` takes its `behavior` from `scrollBehavior()` (`coordinator.js`), `auto` with reduced motion and `smooth` otherwise, never a fixed `smooth`. `test/panel-contrast.test.mjs` checks the CSS, and the safety tests check Settings' scroll to a box.

## Checked against their pattern

A control the panel builds itself (a switch, a disclosure, and any tab list or menu to come) is held to its WAI-ARIA pattern in `test/panel/aria-patterns.test.jsx`, with `checkPattern` from `@ui-sdk/core/testing`, a development dependency pinned exactly that nothing in the extension imports:

- A switch is an `input type="checkbox"` with `role="switch"` and a name (its row's label), and Space turns it on and off.
- A disclosure is a named button with `aria-expanded` `true` or `false` and an `aria-controls` that names a real element; Enter and Space open it and close it again. A button that only opens something (a second press asks again) isn't a disclosure: Clear log's `aria-expanded` is the one left out of the check for that.

A new control of these kinds gets its `checkPattern` there, with its button's act given as the panel does it. A sheet's Tab and Escape are the panel's ([Over the panel](#over-the-panel)), so a view alone can't pass the dialog pattern.
