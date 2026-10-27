# Luna assistance

Luna assistance shows unresolved choice questions in the panel for the agent to accept or dismiss. The packaged mock intercepts OpenAI. It never sends a live provider request.

## Sub-features

- `luna-key` uses the dedicated key field when the agent pastes their own key, and the collection server path when they do not.
- `luna-hold` holds Continue on automatic picks until the agent approves.
- `luna-reload` keeps pending approvals across a panel reload.
- `luna-manual` never sends facts marked for the agent only (`manualOnly`) to Luna.
- `luna-off` sends no request and shows no intake-load check items when Suggest answers is off.

## How to get to it (user POV)

- Choose the brain button (Assistant settings) to turn suggestions off, or to use a personal OpenAI key.
- On Review page, choose **Use this answer** or **No thanks** on a suggestion. **Approve** in the bar confirms automatic picks.

## Driving it with the repo harness

Preconditions:

- `npm run package` has written `dist/tni-rater-autofill`.
- Playwright Chromium is installed.

- **Packaged Luna mock.** Run `npm run mock:luna`. Exit 0. The script loads the packaged extension, intercepts OpenAI, and checks the key field, the automatic-selection switch, approval hold and reload, rejection, conflicting evidence, stale responses, `manualOnly` fields, Mark done, and the intake-load checks.
- **Proof.** Keep stdout in `reviews/verify-tni-rater/luna-assistance/stdout.txt`. Exit 0. Label the proof `Luna mock`. It does not measure live accuracy or billed tokens.

## Gotchas

- Do not run `npm run ai:eval -- --live` as this feature. Live eval needs `OPENAI_API_KEY` and is a separate, explicit ask.
- The mock blanks the Server setting so uploads stay off. `e2e:extension` uses a throwaway local server instead. Do not mix the two setups in one Chrome profile.
- Committed eval cases are synthetic. They are not expert-reviewed accuracy.
