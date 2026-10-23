// Pieces of scripts/package.mjs that are checked by tests.

import crypto from 'node:crypto';

// The scripts injected into the carrier page's own JavaScript world stay there across an extension
// reload or update; each names its build, and one from another build is replaced, not reused.
// The build is the scripts' content hash, stamped into the packaged copies ('source' when the
// repository's files run as they are: tests, the replay pages).
export const STAMPED = ['src/content/field-key.js', 'src/content/pagekit.js'];

// Files of the type check only (npm run typecheck): JSDoc comments that nothing loads at run time,
// left out of the package.
export const TYPES_ONLY = ['src/types.js'];
const PLACEHOLDER = "const BUILD = 'source';";

export const buildId = (texts) => crypto.createHash('sha256').update(texts.join('\0')).digest('hex').slice(0, 12);

export function stampBuild(text, build) {
  if (text.split(PLACEHOLDER).length !== 2) throw new Error(`expected one ${PLACEHOLDER}`);
  return text.replace(PLACEHOLDER, `const BUILD = '${build}';`);
}

// Which copy logged an event and from which code (sidepanel/usage-log.js): the store zip or the
// unpacked copy, and the commit it was packaged from (+dirty when packaged files had changes).
// The repository's files running as they are say 'source' and no commit.
export const PROVENANCE_FILE = 'sidepanel/usage-log.js';
const PROVENANCE = "const PROVENANCE = { channel: 'source', commit: null };";
export function stampProvenance(text, { channel, commit }) {
  if (text.split(PROVENANCE).length !== 2) throw new Error(`expected one ${PROVENANCE}`);
  if (!['store', 'unpacked'].includes(channel)) throw new Error(`unknown channel ${channel}`);
  if (commit != null && !/^[0-9a-f]{7,12}(\+dirty)?$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  return text.replace(PROVENANCE, `const PROVENANCE = { channel: '${channel}', commit: ${commit ? `'${commit}'` : 'null'} };`);
}

// The unpacked copy (Load unpacked) gets a fixed extension ID through this public key, so its
// settings (the agent's OpenAI key among them) survive removing and loading it again, from any
// folder. Only the public half: Chrome needs nothing else for an unpacked extension. Never in the
// store zip: the Chrome Web Store refuses a manifest with a key and gives its own ID.
export const DEV_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr8PERxTmrlU9kI7ekp0/yiAtNNZDXioK/SAqXCvMioK80wbfdItULEKpQ979/bcqcEuS83yugqAdMigTwhHAAyFCMDLzAY8G8jx0QiY8F/I8/SRezncn7K9QnFNzyTa2a2YtuuLUkUiAxwmo3w0CUK5gAAclVI8bCfeHnWbK0RHQXPw6R1ktfm3e+Z8U2++oy/4ytgEMhyVi0Jt0GoXkTymjoPUpGgRTEW5mRxuG7uZXVH/LbiW5RbYtpLfvzyZ0SmvY4w2lG6z91saRDN1qVeaL+Fx14nmeNo3WLsIZT5eSYrCHt+qX8wjff9zHY0r5O2GRvAp0Kw9Yyp4UDPKSyQIDAQAB';
export const DEV_EXTENSION_ID = 'cbpjccegchfackokbiogplhdekblkccj';

export const devManifest = (manifest) => ({ ...manifest, key: DEV_KEY });

// The extension ID Chrome derives from a manifest key.
export function extensionId(key) {
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
