// @ts-check
// The '?' on each of the panel's views (audit 2026-11-07, UX-12b): a link that opens the agent's
// short guide (sidepanel/guide.html, shipped with the panel) in a new tab, at the view's section.
// Nothing on the carrier's page is touched. Home's '?' is in sidepanel.html, written the same way.

// The guide's sections, by the view whose '?' opens them, with what the link says to a screen reader.
const HELP_TOPICS = {
  home: 'Help: starting a quote',
  intake: 'Help: the intake checks',
  page: 'Help: filling and reviewing this page',
  details: 'Help: client details',
  settings: 'Help: Settings',
};

/** @param {{ topic: keyof typeof HELP_TOPICS }} props */
function HelpLink({ topic }) {
  return (
    <a className="help-link" href={`guide.html#${topic}`} target="_blank" rel="noopener" aria-label={HELP_TOPICS[topic]} title={HELP_TOPICS[topic]}
      data-help={topic}>?</a>
  );
}

export { HELP_TOPICS, HelpLink };
