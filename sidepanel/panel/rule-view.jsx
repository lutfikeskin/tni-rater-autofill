// The header's 2px progress rule in React: decorative width from what renderSite assigns to
// state.siteTrack (done steps over total steps). The context line above carries the words.
// One part of the panel; sidepanel.js mounts it (mountSiteRule).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

function SiteRule() {
  const steps = useStore(panelStore, (s) => s.siteTrack) ?? [];
  const done = steps.filter((s) => s.at === 'done' || s.at === 'here filled').length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  return (
    <div className="rule" aria-hidden="true">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Draws the 2px progress rule into #site-rule before returning.
 * @param {HTMLElement} host
 */
function mountSiteRule(host) {
  const root = createRoot(host);
  flushSync(() => root.render(<SiteRule />));
}

export { SiteRule, mountSiteRule };
