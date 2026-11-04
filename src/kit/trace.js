// @ts-check
// Tracing event emitter for developer recording (rater-trace custom event).

let tracing = false;

/**
 * Returns whether recording trace emission is currently enabled.
 * @returns {boolean}
 */
export const isTracing = () => tracing;

/**
 * Enables or disables recording trace emission.
 * @param {boolean} value
 */
export const setTracing = (value) => { tracing = !!value; };

/**
 * Dispatches a rater-trace custom event for developer recording.
 * @param {string} what
 * @param {Record<string, any>} [detail]
 */
export function kitTrace(what, detail = {}) {
  if (!tracing) return;
  try {
    document.dispatchEvent(new CustomEvent('rater-trace', {
      detail: JSON.stringify({ what, t: Date.now(), ...detail }),
    }));
  } catch {
    /* no CustomEvent */
  }
}
