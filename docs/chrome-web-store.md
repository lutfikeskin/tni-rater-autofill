# Publishing to the Chrome Web Store (private, for the pilot agents)

Read this only for an authorized distribution task. Use [testing](testing.md) for release checks; editing documentation or fixing a local rule does not itself require an upload.

A private or unlisted listing lets agents install with one click and get updates automatically,
without Developer mode.

## 1. Build the package

```bash
npm test
npm run package          # -> dist/tni-rater-autofill-<version>.zip
```

A version tagged on `main` gets this zip, built from its tagged commit, on its GitHub Release
([updates](#5-updates)); upload that one when the release workflow attached it.

A build made to try out rather than upload (a test build for the correction loop) is named by the
script: `npm run package -- --label test-build` writes
`dist/tni-rater-autofill-<version>-test-build-<commit>.zip` (`-dirty` when the packaged files had
changes the commit doesn't hold). A label is lowercase words and hyphens.

The zip holds only what the extension runs: `manifest.json`, `background.js`, `icons/`,
`sidepanel/` (the panel as built, PDF.js and fflate bundled in), `src/`, and `THIRD_PARTY_NOTICES.txt`,
the licences of the third-party code it carries (the npm packages the panel's build and the fill
engine took in, with the vendored PDF.js and fflate). It has no source maps: those go in
`dist/tni-rater-autofill-<version>-sourcemaps.zip` beside it, made with the same code, to read an
agent's stack trace against; keep that zip with the upload. The unpacked copy keeps its maps. Raise `version` in `manifest.json` (and `package.json`) for every upload:
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
   - `tabGroups`: an optional permission, asked for only when the agent turns on **Settings →
     Filling → Mark the quote's tab**. "Puts the carrier tab the extension is filling in a tab group titled with what
     it is doing (Filling, Your turn, Done), so the agent sees from another tab when the quote needs
     them." It is optional on purpose: Chrome warns "View and manage your tab groups" for it, and a
     required permission with a new warning disables the store's update on every agent's computer
     until they accept it. The toolbar badge the extension also sets needs no permission.
   - Host permissions: "foragentsonly.com / progressive.com / amwinsadmittedplacement.com /
     geico.com: the carrier quote pages it fills. api.openai.com: Luna suggestions for unresolved
     choice questions, a review of the application's claims box, and a check of drivers' first
     names (for the gender TNI assumes), when the agent saved an OpenAI key of their own.
     usage-server-production.up.railway.app: TNI's usage-log server (how the extension is used, a
     profile of each client's business without names, numbers or addresses, and what an agent types
     into a problem report; a quote summary the agent saves, with the client's answers), which also passes those Luna requests to OpenAI with TNI's key when
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
     is a region ("Location"). A quote summary the agent saves (Save summary) goes to the usage
     server whole, with the client's business name and the answers filled (owner's and drivers'
     names, dates of birth, addresses among them): declare "Personally identifiable information"
     for it too. The store also asks to certify that data isn't used for purposes
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
  (`OPENAI_API_KEY`, [hosting](hosting.md)). Leave *Put checked picks in* off for the first
  weeks of the pilot.

### Managed setup (an agency's Google Admin console)

An organization that installs the extension by policy can also set it up there: **Devices → Chrome →
Apps & extensions → the extension → Policy for extensions**, a JSON object with the keys
`src/managed-schema.json` declares (Chrome reads them into `chrome.storage.managed`):

```json
{ "serverUrl": "https://usage-server-production.up.railway.app", "serverToken": "…", "aiOn": true, "lunaAuto": false, "agent": "JK" }
```

- `serverUrl` and `serverToken` take the place of the built-in central server and its token. The
  server must be at a host the manifest's `host_permissions` allow. A policy token alone goes to the
  central server; the built-in token never goes to another server.
- `aiOn` (**Suggest answers**) and `lunaAuto` (**Put checked picks in**) are the defaults the agent
  starts with.
- `agent` is the agent's initials (1 to 6 letters or digits), for a computer one agent uses: until
  they enter their own under **You**, their quotes count under these, and setup counts them done.
- What the agent sets in Settings still wins (Advanced is for setup, such as a local test server).
  Settings says when uploads go to a server the organization set. A value out of its type is
  ignored. The schema adds no permission and no install warning.

## 5. Updates

Raise the version and merge it to `main`, then wait for that push's **Release tag** run to finish
all its jobs: the release is made before its zip is built and attached. When the run passed and its
attach job uploaded `tni-rater-autofill-<version>.zip` (its log has no "already has
tni-rater-autofill-<version>.zip: left as it is" line), that zip is the tagged commit's: upload it
on the item's **Package** tab, and submit. Otherwise build it yourself:

1. If the run failed because `v<version>` already names another commit, stop: resolve the tag by
   hand first, so that it names the commit that set the version in `manifest.json`.
2. Check out that commit (`git checkout v<version>`, or for an untagged version the commit that set
   it), then run `npm ci`, so `node_modules` matches its lockfile.
3. Run `npm run package` there from a clean tree (the usage events name the commit they were
   packaged from, `+dirty` otherwise), and upload that zip.

A zip the release already had before the run (uploaded by hand) is unchecked: build it yourself as
above rather than upload it.
In the version's PR, add what agents will see differently to `src/whats-new.js` under the new
version: one to five short lines in the agent's words. The panel shows them once, as "What's new in
v<version>", the first time it opens after the update, with every version's lines since the one it
last showed (or the version updated from, when it never showed one); a version with no lines shows
nothing, and a new install isn't told. `test/whats-new.test.mjs` checks the lines' shape.
Chrome downloads the new version within a few hours of approval. It doesn't swap it under an open panel: the service worker keeps the downloaded version (`onUpdateAvailable`, `updateReady`), and the panel shows **Update ready: v<version>** with **Reload now**, which reloads the extension into it unless a fill is running (then the card says to reload once it ends; audit 2026-11-07, GAP-07). An agent who never reloads gets it when Chrome restarts.

When the version bump reaches `main`, [release-tag.yml](../.github/workflows/release-tag.yml)
tags the commit that set the version `v<version>` and makes a GitHub Release whose notes are the
pull requests merged since the version before it (`scripts/release-notes.mjs`, which prints them
here without changing anything: `node scripts/release-notes.mjs --version 0.9.32`). Only the push
that brings the version bump tags it: a version already on `main` before that push is never
tagged, and there is no manual run, so versions released before the workflow stay untagged. A tag
that already names the same commit is left as it is; one that names another commit fails the run,
to be checked by hand. A second job then checks out the tagged commit and runs `npm run package`. It can only read, since
packaging runs the project's dependencies. A third job, which runs nothing of the project, attaches
`tni-rater-autofill-<version>.zip` to the release, with the source maps' zip beside it when the
package makes one. A missing store zip fails the run, and an asset the release already has is left
as it is, unchecked: the workflow vouches only for a zip it attached itself, and its attach job's
log says when it left one ("already has …: left as it is"), not for one uploaded to the release by
hand. The tag says which
commit a store version came from, the notes what changed, and the release's zip, when that run
attached it, is the one built from that commit and the one to upload; the workflow uploads nothing
to the store.

Agents' own defaults ([spec](agent-defaults-spec.md)) ship hidden in the store build until TNI's
managers approve them: that release's PR sets `RELEASED_TO_AGENTS` to `true` in
`src/agent-defaults/index.js`. The unpacked copy has them on regardless (Settings → Advanced, for
setup only, hides them there to see the panel as agents will).

## API keys for the pilot

OpenAI access is TNI's: `OPENAI_API_KEY` on the usage server ([hosting](hosting.md)), in its own
OpenAI project with what bounds its spending set up there, so agents enter no key. An agent can still use one of their
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
