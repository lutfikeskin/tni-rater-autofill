export interface FieldSnapshot {
  initialValue: string | boolean;
  dirty: boolean;
  lastGestureTimestamp: number;
}

export function getDeepActiveElement(root: Document | ShadowRoot = document): Element | null {
  let active = root.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

export function containsFocus(e: Element): boolean {
  const deepActive = getDeepActiveElement();
  if (!deepActive) return false;

  if (e === deepActive || e.contains(deepActive)) {
    return true;
  }

  const ariaControls = e.getAttribute('aria-controls');
  if (ariaControls) {
    const controlledPopup = document.getElementById(ariaControls);
    if (controlledPopup && (controlledPopup === deepActive || controlledPopup.contains(deepActive))) {
      return true;
    }
  }

  const ariaOwns = e.getAttribute('aria-owns');
  if (ariaOwns) {
    const ownedPopup = document.getElementById(ariaOwns);
    if (ownedPopup && (ownedPopup === deepActive || ownedPopup.contains(deepActive))) {
      return true;
    }
  }

  const labelledBy = deepActive.getAttribute('aria-labelledby');
  if (labelledBy && (e.id && labelledBy.split(/\s+/).includes(e.id))) {
    return true;
  }

  return false;
}

export class CoPilotGuard {
  private readonly gestureWindowMs = 2000;
  private snapshots = new WeakMap<Element, FieldSnapshot>();

  constructor() {
    this.attachCaptureListeners();
  }

  private attachCaptureListeners(): void {
    if (typeof window === 'undefined') return;

    const recordGesture = (evt: Event) => {
      if (!evt.isTrusted) return;
      const now = performance.now();
      const target = evt.composedPath()[0] as Element;
      if (target && target instanceof Element) {
        let snap = this.snapshots.get(target);
        if (!snap) {
          snap = {
            initialValue: this.extractValue(target),
            dirty: false,
            lastGestureTimestamp: now
          };
          this.snapshots.set(target, snap);
        }
        snap.lastGestureTimestamp = now;

        if (evt.type === 'input' || evt.type === 'change') {
          snap.dirty = true;
        }
      }
    };

    ['pointerdown', 'mousedown', 'keydown', 'input', 'change', 'paste', 'drop'].forEach((type) => {
      window.addEventListener(type, recordGesture, { capture: true, passive: true });
    });
  }

  public registerFieldBaseline(el: Element): void {
    if (!this.snapshots.has(el)) {
      this.snapshots.set(el, {
        initialValue: this.extractValue(el),
        dirty: false,
        lastGestureTimestamp: 0
      });
    }
  }

  private extractValue(el: Element): string | boolean {
    if (el instanceof HTMLInputElement) {
      return el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
    }
    if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      return el.value;
    }
    return el.getAttribute('value') || '';
  }

  public isGuarded(el: Element, now: number = performance.now()): { guarded: boolean; reason?: string } {
    const snap = this.snapshots.get(el);

    if (snap && now - snap.lastGestureTimestamp <= this.gestureWindowMs) {
      return { guarded: true, reason: 'RECENT_TRUSTED_GESTURE' };
    }

    const deepActive = getDeepActiveElement();
    if (deepActive === el) {
      return { guarded: true, reason: 'ACTIVE_ELEMENT_FOCUS' };
    }

    if (containsFocus(el)) {
      return { guarded: true, reason: 'CONTAINED_POPUP_FOCUS' };
    }

    if (snap && snap.dirty && this.extractValue(el) !== snap.initialValue) {
      return { guarded: true, reason: 'USER_MODIFIED_DIRTY_VALUE' };
    }

    return { guarded: false };
  }
}