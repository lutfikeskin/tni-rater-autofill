# Publishing to the Chrome Web Store (private, for the pilot agents)

Read this only for an authorized distribution task. Use [testing](testing.md) for release checks; editing documentation or fixing a local rule does not itself require an upload.

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
   - `unlimitedStorage`: "Keeps the usage log on the agent's computer while TNI's usage server
     can't be reached, so what happened isn't lost before it's uploaded (no client names, numbers or
     addresses; the business profile and problem reports are described in the privacy policy)."
   - Host permissions: "foragentsonly.com / progressive.com / amwinsadmittedplacement.com /
     geico.com: the carrier quote pages it fills. api.openai.com: Luna suggestions for unresolved
     choice questions, a review of the application's claims box, and a check of drivers' first
     names (for the gender TNI assumes), when the agent saved an OpenAI key of their own.
     usage-server-production.up.railway.app: TNI's usage-log server (how the extension is used, a
     profile of each client's business without names, numbers or addresses, and what an agent types
     into a problem report), which also passes those Luna requests to OpenAI with TNI's key when
     the agent has none, storing nothing.
     localhost: a local test server."
   - Data usage: declare what the extension handles (form content from the intake PDF and carrier
     page, sent to OpenAI when the AI assistant is on, as it is unless the agent turns it off, with
     client names and numbers redacted: directly with the agent's own key, or through TNI's usage
     server, which adds TNI's key and stores nothing).
     With the assistant on, drivers' first names are sent to OpenAI unredacted, alone in their own
     request: declare "Personally identifiable information" (name). The usage server gets a
     profile of each client's business (the privacy policy lists it): drivers' ages, marital
     status and gender as the agent set it are personal information too, and the garaging state
     is a region ("Location"). The store also asks to certify that data isn't used for purposes
     unrelated to the extension's single purpose; analysing TNI's own quoting from the usage log is
     a purpose beyond filling quotes. TNI's compliance owner should confirm these answers, and
     that certification, before a version that sends the profile is uploaded.
4. **Distribution** → Visibility: *Private* (domain or trusted testers) or *Unlisted*.
5. **Submit for review**. Reviews usually take from a few hours to a few days; the dashboard
   shows the status.

## 4. Agents install it

Send them the listing link (dashboard → *Store listing* → view). In Chrome: **Add to Chrome** →
pin the extension → click it to open the side panel. Then, once each:

- **Settings → You → Your initials** (the gear at the top of the panel). The usage log goes to TNI's server by itself (see hosting.md).
- Nothing to do for the assistant: *Suggest answers* is on and uses TNI's key on the usage server
  (`OPENAI_API_KEY`, [hosting](hosting.md)). Leave *Put checked picks in for me* off for the first
  weeks of the pilot.

## 5. Updates

Raise the version, `npm run package` from a clean, committed tree (the usage events name the
commit they were packaged from, `+dirty` otherwise), upload the new zip on the item's **Package**
tab, submit.
Chrome updates installed copies by itself within a few hours of approval.

## API keys for the pilot

OpenAI access is TNI's: `OPENAI_API_KEY` on the usage server ([hosting](hosting.md)), in its own
OpenAI project with a monthly budget, so agents enter no key. An agent can still use one of their
own under **Settings → Assistant → Use my own key**.
Check available account controls for access and spending before a wider rollout. Live quality and
latency testing requires an OpenAI key and explicit evaluation approval.

## Store listing text (paste as is)

- **Category:** Productivity → Workflow & Planning
- **Language:** English (United States)
- **Description:**

```text
TNI Rater Autofill is the internal quoting assistant for Truckers National Insurance (TNI) agents.

Load the client's TNI Commercial Insurance Quote Application (PDF) in the side panel, open the carrier's quote page, and click Fill this page. The extension fills the quote from the application and TNI's standard answers:

• Progressive Commercial Auto (ForAgentsOnly)
• AmWINS Admitted Placement – Business Auto
• GEICO Commercial Auto (sales.geico.com quote)

What it does
• Reads the quote application on your computer and lets you check and correct it before filling.
• Fills one page at a time, checks that each answer was kept by the carrier's page, and marks every field: filled, TNI standard, needs you, couldn't fill, or AI answer.
• Moves to the next step only when nothing is left for you, and never binds, buys, submits or signs anything.
• Leaves MVR/CLUE orders, declarations and bank/card details to you. Some coverage and exclusion answers use programmed defaults; review them for this client's circumstances.
• AI tips for questions the rules don't cover, on unless you turn them off, through TNI's OpenAI account or your own key; nothing goes in without your approval unless you allow it.

Privacy
The application stays on your computer for the session. With the AI assistant on (it is unless you turn it off), parts of it go to OpenAI, through TNI's server with TNI's key or directly with your own: client names and numbers are replaced, except drivers' first names, which are sent alone for the gender check. To improve the extension and analyse TNI's own quoting, a usage log (which fields were filled, what you changed afterwards, problems you report) and a profile of each client's business (state, operations, vehicles, drivers' ages, coverages; no names, numbers or addresses) are sent to TNI's server; client names, numbers and what you type into the quote are not included. A problem report is sent as you type it, with values from the loaded application, if one is loaded, replaced only where they appear exactly as written there, so don't type client details into it.

For TNI agents only.
```
