// @ts-check
// The focus of a question the panel asks in place (audit 2026-11-07, UX-17), as askFile moves it for
// the file tools' question: Cancel takes the focus when the question opens, and the button that asked
// gets it back when the question closes with the focus still in it, or gone with it (Cancel, or a
// yes). A yes can take the button that asked away with what it deleted (Delete profile): the focus
// then goes to `fallback`, a control that stays (the Profile menu).
// Settings' Clear log and Your defaults' Delete profile use it.
// One part of the panel; the views import it.
import { useEffect, useRef } from 'react';

/**
 * @param {boolean} open whether the question is asked now
 */
export function useAskFocus(open) {
  /** @type {{ current: HTMLElement | null }} */
  const opener = useRef(null);
  /** @type {{ current: HTMLElement | null }} */
  const cancel = useRef(null);
  /** @type {{ current: HTMLElement | null }} */
  const group = useRef(null);
  /** @type {{ current: HTMLElement | null }} */
  const fallback = useRef(null);
  const was = useRef(false);
  // Closed with the focus in it: the focus is the asker's until the agent moves it elsewhere, also on
  // a later draw (a deletion saved after the yes takes Delete profile away then).
  const back = useRef(false);
  useEffect(() => {
    const at = document.activeElement;
    const lost = !at || at === document.body || !at.isConnected || !!group.current?.contains(at);
    if (open) {
      if (!was.current) cancel.current?.focus();
      back.current = false;
    } else {
      if (was.current && lost) back.current = true;
      if (back.current && !lost && at !== opener.current) back.current = false;
      else if (back.current && lost) (opener.current?.isConnected ? opener.current : fallback.current)?.focus();
    }
    was.current = open;
  });
  return { opener, cancel, group, fallback };
}
