// @ts-check
// Deploying the usage server only from the default branch as merged (audit 2026-11-07, SRV-10):
// `railway up` uploads the working tree as it is, and the shared checkout may be on any branch,
// with edits that were never reviewed. scripts/deploy-server.mjs gathers the facts; these decide.

/**
 * The repository files the server image is built from: server/Dockerfile and its COPY sources.
 * @param {string} dockerfile
 * @returns {string[]}
 */
export function imageFiles(dockerfile) {
  const files = ['server/Dockerfile'];
  for (const [, rest] of dockerfile.matchAll(/^COPY\s+(.+)$/gm)) {
    const words = rest.trim().split(/\s+/).filter((w) => !w.startsWith('--'));
    files.push(...words.slice(0, -1));
  }
  return files;
}

/**
 * The files `git status --porcelain` names, from its output as printed (untrimmed: an unstaged
 * change's line starts with a space). A rename names its new path.
 * @param {string} porcelain
 * @returns {string[]}
 */
export function dirtyFiles(porcelain) {
  return porcelain.split('\n').filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^.* -> /, ''));
}

/**
 * Why this checkout must not be deployed, or null when it may.
 * @param {{ fetched: boolean, head: string | null, upstream: string | null, defaultBranch: string, dirty: string[] }} facts
 *   head: this checkout's commit; upstream: origin/<defaultBranch>'s after a fetch; dirty: the
 *   image's files with uncommitted changes (untracked included).
 * @returns {string | null}
 */
export function deployProblem({ fetched, head, upstream, defaultBranch, dirty }) {
  const target = `origin/${defaultBranch}`;
  if (!fetched || !upstream) return `could not fetch ${target}: deploy only what is merged, so check the connection and try again`;
  if (head !== upstream) return `this checkout is ${head ?? 'unknown'}, not ${target} as merged (${upstream}): check out ${defaultBranch} and git pull, or deploy from a checkout that is`;
  if (dirty.length) return `uncommitted changes to what the image is built from: ${dirty.join(', ')}. Commit them through a PR, or set them aside`;
  return null;
}

/**
 * Asks `check` until it answers 'same', within one overall deadline: a check still waiting when the
 * deadline passes is aborted (its signal) and not waited for, so a stalled health request can't
 * keep the deploy past it (the review of #426).
 * @param {(signal: AbortSignal) => Promise<{ status: string }>} check
 * @param {{ deadlineMs: number, intervalMs: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} opts
 * @returns {Promise<boolean>} whether it answered 'same' in time
 */
export async function waitForSame(check, { deadlineMs, intervalMs, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const end = now() + deadlineMs;
  while (now() < end) {
    const ac = new AbortController();
    /** @type {Promise<null>} */
    const expired = new Promise((resolve) => ac.signal.addEventListener('abort', () => resolve(null)));
    const timer = setTimeout(() => ac.abort(), Math.max(0, end - now()));
    let answer;
    try {
      answer = await Promise.race([check(ac.signal), expired]);
    } finally { clearTimeout(timer); }
    if (answer?.status === 'same') return true;
    const left = end - now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left));
  }
  return false;
}
