# Publishing to the Chrome Web Store (private, for the pilot agents)

A private or unlisted listing lets agents install with one click and get updates automatically,
without Developer mode.

## 1. Build the package

```bash
npm test
npm run package          # -> dist/tni-rater-autofill-<version>.zip
```

The zip holds only what the extension runs: `manifest.json`, `background.js`, `icons/`, `lib/`,
`sidepanel/`, `src/`. Raise `version` in `manifest.json` (and `package.json`) for every upload:
the store refuses a version it already has.

## 2. One-time setup

1. Sign in to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   with the TNI Google account that should own the extension, and pay the one-time registration fee.
2. **Private** visibility shows the listing only to people you name:
   - if TNI uses Google Workspace, publish to everyone in the TNI domain, or
   - add the 5 agents' Google account emails as **trusted testers** (Account page of the dashboard).
   **Unlisted** works too: anyone with the link can install, nobody else finds it.

## 3. Create the item

1. **New item** → upload the zip.
2. **Store listing**: name, a short description, category *Productivity*, the 128px icon
   (`icons/icon-128.png`), and at least one screenshot of the side panel (1280×800 or 640×400).
3. **Privacy practices** (the store requires this tab before it will publish). Text you can paste:
   - *Single purpose*: "Fills a commercial auto insurance quote on carrier agent portals from the
     client's TNI quote application PDF, and suggests answers for questions it can't fill."
   - `sidePanel`: "The extension's interface is a side panel next to the carrier's quote page."
   - `scripting`: "Fills and highlights form fields on the carrier quote page the agent is viewing."
   - `storage`: "Keeps the loaded intake for the session and the agent's settings."
   - Host permissions: "foragentsonly.com / progressive.com / geico.com: the carrier quote pages it
     fills. api.openai.com: AI suggestions for unanswered questions, with the agent's own API key.
     usage-server-production.up.railway.app: TNI's usage-log server (how the extension is used, no client
     details). localhost: a local test server."
   - Data usage: declare what the extension handles (form content from the intake PDF and carrier
     page, sent to OpenAI when the AI assistant is on). TNI's compliance owner should confirm
     these answers.
4. **Distribution** → Visibility: *Private* (domain or trusted testers) or *Unlisted*.
5. **Submit for review**. Reviews usually take from a few hours to a few days; the dashboard
   shows the status.

## 4. Agents install it

Send them the listing link (dashboard → *Store listing* → view). In Chrome: **Add to Chrome** →
pin the extension → click it to open the side panel. Then, once each:

- **Usage log → Your initials**. The usage log goes to TNI's server by itself (see hosting.md).
- **AI assistant** → tick *Suggest answers*, paste their API key, leave the model blank for
  `gpt-6-luna`. Leave *Let the AI select answers it's sure of* off for the first weeks of the
  pilot.

## 5. Updates

Raise the version, `npm run package`, upload the new zip on the item's **Package** tab, submit.
Chrome updates installed copies by itself within a few hours of approval.

## API keys for the pilot

Create the agents' keys in TNI's own OpenAI organisation (one project for the pilot, one key per
agent, a monthly budget on the project), so each key can be revoked on its own and usage shows
per agent. When the pilot grows, the roadmap's server-held key (see `docs/ai-assistant.md`)
removes keys from the agents' browsers.

## Store listing text (paste as is)

- **Category:** Productivity → Workflow & Planning
- **Language:** English (United States)
- **Description:**

```text
TNI Rater Autofill is the internal quoting assistant for Truckers National Insurance (TNI) agents.

Load the client's TNI Commercial Insurance Quote Application (PDF) in the side panel, open the carrier's quote page, and click Fill this page. The extension fills the quote from the application and TNI's standard answers:

• Progressive Commercial Auto (ForAgentsOnly)
• AmWINS Admitted Placement – Business Auto
• GEICO commercial pages (common fields)

What it does
• Reads the quote application on your computer and lets you check and correct it before filling.
• Fills one page at a time, checks that each answer was kept by the carrier's page, and marks every field: filled, needs you, or couldn't fill.
• Moves to the next step only when nothing is left for you, and never binds, buys, submits or signs anything.
• Leaves MVR/CLUE orders, driver exclusions, declarations and payment details to you.
• Optional AI tips (with your own OpenAI key) for questions the rules don't cover; nothing goes in without your approval unless you allow it.

Privacy
The application stays on your computer for the session. To improve the extension, a usage log (which fields were filled, what you changed afterwards, problems you report) is sent to TNI's server; client names, numbers and anything you type are never included.

For TNI agents only.
```
