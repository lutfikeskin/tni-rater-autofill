// The side panel's source as one text: its parts (sidepanel/panel/) in the order they were one
// file, then sidepanel.js, which wires them. Tests that read a panel function or line by its name or
// words find it in whichever part it lives.
import fs from 'node:fs';

export const PANEL_FILES = ['env', 'state-store', 'core', 'intake', 'record', 'tab', 'usage', 'scope', 'fill-checks', 'live', 'report-model', 'coordinator', 'fill', 'dev-recording',
  'assistant', 'usage-panel', 'pdf-view', 'window'].map((part) => `sidepanel/panel/${part}.js`).concat('sidepanel/sidepanel.js');

export const PANEL_SOURCE = PANEL_FILES.map((f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
