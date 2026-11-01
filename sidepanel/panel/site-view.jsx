// The quote's steps in the header's strip in React (#site-track): one mark per step of the quote,
// those before the tab's step done, the tab's own here (and filled once its page has a report), from
// what renderSite (coordinator.js) says (state.siteTrack). renderSite shows or hides the strip.
// One part of the panel; sidepanel.js mounts it (mountSiteTrack).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

// Each step: its `name` (the mark's title) and `at`: 'done', 'here', 'here filled' or null (to come).
function SiteTrack() {
  const steps = useStore(panelStore, (s) => s.siteTrack) ?? [];
  return steps.map((step, i) => <span key={i} title={step.name} className={step.at ?? undefined} />);
}

// Draws the strip into #site-track, before it returns.
function mountSiteTrack(host) {
  const root = createRoot(host);
  flushSync(() => root.render(<SiteTrack />));
}

export { SiteTrack, mountSiteTrack };
