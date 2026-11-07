// @ts-check
// Which commit is which extension version, and what changed in it (audit 2026-11-07, ORG-13).
// A version's release is the commit on main (first parent) that set manifest.json's version to it;
// scripts/release-notes.mjs and .github/workflows/release-tag.yml tag it v<version> with these notes.

/** git log's format for parseLog: hash, subject and body, separated by unit and record separators. */
export const LOG_FORMAT = '%H%x1f%s%x1f%b%x1e';

/**
 * @param {string} text git log output in LOG_FORMAT
 * @returns {{ sha: string, subject: string, body: string }[]}
 */
export function parseLog(text) {
  return text.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r.trim()).map((r) => {
    const [sha, subject, body = ''] = r.split('\x1f');
    return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
  });
}

/**
 * A commit as its pull request: a merge commit's subject only names the branch, so its body's first
 * line (the PR's title) is used; a squash merge's subject already ends in (#n).
 * @param {{ subject: string, body: string }} commit
 */
export function prTitle({ subject, body }) {
  const m = /^Merge pull request #(\d+) from \S+$/.exec(subject);
  if (!m) return subject;
  const title = body.split('\n').map((l) => l.trim()).find(Boolean);
  return `${title ?? subject} (#${m[1]})`;
}

/**
 * @param {{ version: string, previous: string | null, commits: { subject: string, body: string }[] }} release
 *   commits: first-parent commits after the previous release up to this one, newest first, as git
 *   log gives them; listed oldest first.
 */
export function releaseNotes({ previous, commits }) {
  if (!previous) return 'The first tagged version.\n';
  const lines = [...commits].reverse().map((c) => `- ${prTitle(c)}`);
  return `What changed on main since v${previous}, by pull request:\n\n${lines.join('\n')}\n`;
}

const VERSION = /^\d+\.\d+\.\d+$/;
/** @param {string | null} json */
const versionIn = (json) => {
  try { return json ? JSON.parse(json).version ?? null : null; } catch { return null; }
};

/**
 * The commit that set main's manifest.json to `version`, and the release before it.
 * @param {(...args: string[]) => string | null} git runs git in the repository; null when it fails
 * @param {string} version
 * @param {string} [ref] the branch whose first-parent history is read
 * @returns {{ version: string, target: string, previous: string | null, previousTarget: string | null } | null}
 */
export function releaseOf(git, version, ref = 'HEAD') {
  if (!VERSION.test(version)) throw new Error(`${version} is not a version (x.y.z)`);
  /** @param {string} v */
  const setting = (v) => {
    const pattern = `"version": *"${v.replace(/\./g, '\\.')}"`;
    const shas = (git('log', '--first-parent', '--reverse', '--format=%H', `-G${pattern}`, ref, '--', 'manifest.json') ?? '').split('\n').filter(Boolean);
    // The first commit whose manifest has the version (a later one may only remove it).
    return shas.find((sha) => versionIn(git('show', `${sha}:manifest.json`)) === v) ?? null;
  };
  const target = setting(version);
  if (!target) return null;
  const previous = versionIn(git('show', `${target}^1:manifest.json`));
  const previousTarget = previous ? setting(previous) : null;
  return { version, target, previous: previousTarget ? previous : null, previousTarget };
}
