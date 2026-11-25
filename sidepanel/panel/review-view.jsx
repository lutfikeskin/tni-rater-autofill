// @ts-check
// Legacy Review mount point: post-fill Needs, Worth a look, and All answers now live in the
// single unified tabbed sheet in feed-view.jsx + report-view.jsx (Model 2), so Review renders
// nothing and eliminates duplicate post-fill screens.

/**
 * @returns {null}
 */
function Review() {
  return null;
}

/**
 * No-op mount kept for panel wiring compatibility.
 * @param {HTMLElement | null} [host]
 * @param {Record<string, any>} [_act]
 */
function mountReview(host, _act) {
  void _act;
  if (host) host.replaceChildren();
}

export { Review, mountReview };
