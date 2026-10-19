# Windows development

Use native PowerShell, Git and **Node.js 22** (the CI version). Install Chrome
**140 or newer** for manual extension use. WSL, Python, `cp` and a system `zip`
program are not required. Browser checks install their own Playwright Chromium.

## Get the code and check the installation

Clone with Git so later updates and task branches are available:

```powershell
git clone https://github.com/lutfikeskin/tni-rater-autofill.git
cd tni-rater-autofill
```

Work from `main`; the Windows preparation (#68) is merged. The repository's `.gitattributes` keeps
source line endings consistent even when Git for Windows uses `autocrlf`.
Then install and check:

```powershell
node --version
npm ci
npx playwright install chromium
npm test
npm run package
```

If PowerShell blocks `npm.ps1` or `npx.ps1` under its execution policy, use
`npm.cmd` and `npx.cmd` in those commands. No policy change is needed.

`npm ci` restores the locked dependencies, including the ZIP library used by
packaging. The two PDF.js runtime files are already committed in `lib/`;
`npm run vendor` is only for deliberately refreshing them after a dependency
update. Do not copy `node_modules` from the Mac.

## Load and develop the extension

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select `dist\tni-rater-autofill`.
3. Open the panel and set **Usage log → Server** to `http://localhost:8787`
   when developing with `npm run server`, or blank it to disable uploads.
   The default is the production collection server.
4. After source edits, run `npm run package`, reload the extension in Chrome,
   and reopen its side panel.

The fixed development extension ID does not transfer settings between computers.
Enter your initials, server preference and optional OpenAI API key on the new
machine. Unit tests, browser mocks and fixture replays require no API key or
production server credentials. Real AI use and production log access need their
own credentials; never commit them. The log CLI accepts `RATER_SERVER`,
`RATER_TOKEN` and `RATER_ADMIN_TOKEN` as environment variables, or reads tokens
from `$HOME\.config\tni-rater\` as described in [hosting](hosting.md).

## Browser checks

These commands serve their own local fixtures:

```powershell
npm run mock:amwins
npm run mock:amwins -- --reversed
npm run e2e -- --fixtures
npm run e2e -- --fixtures --renumber
npm run mock:luna
```

Luna needs the package built above. Some fixture assets come from pinned CDNs,
so browser installation and those replays need internet access.

The packaged extension check also needs the replay server. In one terminal:

```powershell
npm run replay
```

Keep that running and use another terminal in the same checkout:

```powershell
npm run e2e:extension
```

The replay server binds only to `127.0.0.1:8792`; stop it with Ctrl+C afterward.
Open `http://localhost:8792/test/replay/` for manual replay, or
`http://localhost:8792/test/mock-rater/` for the generic mock. For manual preview
on another port, use `npm run replay -- --port 8791`; the extension test requires
8792. See [testing](testing.md) for which checks a change needs and what they prove.

## What a clone contains

Source, vendored PDF.js, lockfile, scrubbed fixtures, the two small sample intake
PDFs, replay baselines and project guidance are tracked. The current development
context is in [the handoff](handoff-2026-10-09.md); it does not depend on ignored
review reports from the Mac. `dist/` is rebuilt by packaging.

The larger 100-case pool in `dist/synthetic-intakes/` is **not tracked**. It
retains a source-intake VIN and must stay out of Git. It is optional for the
checks above, but required for `npm run test:intakes`. Transfer its `manifest.json`,
`pdfs/` and matching `lookups/` privately from the previous machine, keeping the
folder structure. Do not add it to the repository. Once copied:

```powershell
npm run test:intakes -- --carrier amwins --cases 03,09
# Or keep it outside this checkout:
npm run test:intakes -- --pool "C:\Work data\synthetic-intakes" --carrier amwins --cases 03,09
```

The preparation task also creates an ignored local `dist/windows-transfer/`
archive for private transfer. It contains the required pool files and snapshots
of the two authored, uncommitted worktrees, with their base commits and restore
notes. It is not uploaded to GitHub and excludes credential files, browser
profiles and production usage logs. Treat the pool as private data. Those draft
worktrees are separate work, not part of the merged application; do not apply
their patches to `main` without reviewing their intended scope.

Raw `layouts/`, production `server-data/`, local credentials and Chrome profiles
also do not come with a clone. They are not prerequisites for ordinary development
or the checks above. Set up credentials separately only when the task needs them.
