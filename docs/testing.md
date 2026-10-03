# Testing and release verification

Read this when choosing checks, changing a harness or baseline, or preparing an authorized release.

## Choose checks for the change

The extension uses plain ES modules with no source build step. `npm install` installs development dependencies; `npm test` runs `node:test` files under `test/`. Run a focused file with `node --test test/pagekit.test.mjs`. Browser runners use Playwright Chromium (`npx playwright install chromium` once when needed).

| Affected behavior | Relevant checks |
| --- | --- |
| Intake extraction or cleanup | `test/normalize.test.mjs`, `test/intake-regressions.test.mjs`; affected synthetic intake cases |
| Progressive rules or page execution | `test/progressive.test.mjs`, `test/pagekit.test.mjs`, `npm run e2e -- --fixtures` |
| AmWINS rules or application flow | `npm run mock:amwins` before completing an AmWINS rule change |
| Panel orchestration or packaged behavior | `test/sidepanel-safety.test.mjs`, `npm run e2e:extension` |
| AI validation, approvals, caching | `test/assist.test.mjs`, `npm run mock:ai` |
| Events, learning, layout coverage, transport | Corresponding `usage`, `usage-log`, `learn`, `coverage`, `server`, and `consistency` test files |
| Documentation only | Link/command checks, current-code audit, and `git diff --check`; no browser run or version bump |

Run `npm test` for code changes, plus affected integration checks. Repeat or broaden only for new changes, failures, or unresolved concerns. Do not add tests that merely mirror a low-impact edit.

## Browser harnesses and limits

- `npm run e2e` runs Progressive layout replays; `--fixtures` uses committed per-state fixtures, including in CI. Local runs can also include captures and generated layouts. A replay does not establish complete live navigation, server acceptance, or real lookup reliability.
- `npm run mock:amwins` checks the saved-site behavior mock and its expected answers, including continuation and no submission.
- `npm run e2e:extension` needs `npm run package` and `npm run replay` serving on port 8792. It runs the packaged panel/extension on the AmWINS mock.
- `npm run mock:ai` needs the package and uses controlled model responses. It checks interaction and approval behavior, not a live model's accuracy or latency.
- `npm run test:intakes -- --carrier amwins --cases 03,09` selects synthetic cases. The pool under `dist/synthetic-intakes` is local and untracked; read [intake-mocks.mjs](../scripts/intake-mocks.mjs) for available options. Missing pool data is a stated limitation, not evidence of a pass.

## Baselines and fixtures

For relevant new Progressive captures: build layouts with `npm run layouts`, review them, and use `npm run fixtures:progressive` to refresh scrubbed fixtures. Review the expected behavior before accepting `npm run e2e -- --update`; a baseline is not an answer key. Preserve unrelated baseline entries.

For AmWINS page changes, update the scrubbed [fixtures](../test/fixtures/amwins/) and expected answers in [amwins-mock.mjs](../scripts/amwins-mock.mjs). Retain branch behavior rather than only static markup.

## CI and authorized releases

[checks.yml](../.github/workflows/checks.yml) runs unit tests, AmWINS mock, Progressive committed-fixture replay, packaging, and packaged-extension E2E. Run the release checks before shipping. Do not claim CI passed based only on local tests.

For a shipped extension version, keep [manifest.json](../manifest.json) and [package.json](../package.json) in sync and update the lockfile's package metadata. `npm run package` produces the zip and unpacked directory under ignored `dist/`. A local correction or documentation change does not itself authorize a version bump or upload.

Use [store release](chrome-web-store.md) only for distribution, and [hosting](hosting.md) only for server deployment. Verify the requested outcome, including retained page values or a generated document when that is part of the task; distinguish mock, packaged-extension, and live evidence.
