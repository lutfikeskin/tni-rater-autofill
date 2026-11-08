// @ts-check
// The focus of a question the panel asks in place (audit 2026-11-07, UX-17), as askFile moves it for
// the file tools' question: Cancel takes the focus when the question opens, and the button that asked
// gets it back when the question closes with the focus still in it, or gone with it (Cancel, or a
// yes). Settings' Clear log and Your defaults' Delete profile use it.
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
  const was = useRef(false);
  useEffect(() => {
    if (open && !was.current) cancel.current?.focus();
    else if (!open && was.current) {
      const at = document.activeElement;
      if (!at || at === document.body || !at.isConnected || group.current?.contains(at)) opener.current?.focus();
    }
    was.current = open;
  }, [open]);
  return { opener, cancel, group };
}
