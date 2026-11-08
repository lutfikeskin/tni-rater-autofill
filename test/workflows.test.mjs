// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), 'utf8');

// Audit 2026-11-07, QA-13: a failing mock left only log lines, and the Windows run waited for
// someone to dispatch it.
test('a failed mock or replay job keeps what its run left, and the Windows smoke runs nightly', () => {
  const checks = read('checks.yml');
  const browser = checks.slice(checks.indexOf('\n  browser:'));
  assert.match(browser, /- name: Keep what the failed run left\n\s+if: failure\(\)\n\s+uses: actions\/upload-artifact@v4\n\s+with:\n\s+name: \$\{\{ matrix\.name \}\}\n\s+path: \|\n\s+\$\{\{ runner\.temp \}\}\/artifacts\n\s+reviews\/e2e-\*\.md\n\s+retention-days: 7/);
  // The Luna mock writes its screenshots and diagnostics there.
  assert.match(browser, /npm run mock:luna -- "\$RUNNER_TEMP\/artifacts"/);
  // Only the mock and replay jobs keep artifacts.
  assert.equal((checks.match(/upload-artifact/g) ?? []).length, 1);
  const windows = read('windows-smoke.yml');
  assert.match(windows, /on:\n\s+workflow_dispatch:\n\s+schedule:\n\s+- cron: '30 6 \* \* \*'/);
});
