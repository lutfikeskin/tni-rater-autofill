// Where the central usage server is and the tokens for it: RATER_SERVER / RATER_TOKEN /
// RATER_ADMIN_TOKEN, else ~/.config/tni-rater/{upload-token,admin-token} (kept out of the repo).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CENTRAL_SERVER = 'https://usage-server-production.up.railway.app';

const fromFile = (name) => {
  try { return fs.readFileSync(path.join(os.homedir(), '.config', 'tni-rater', name), 'utf8').trim(); } catch { return ''; }
};

export const serverUrl = () => (process.env.RATER_SERVER || CENTRAL_SERVER).replace(/\/$/, '');
export const uploadToken = () => process.env.RATER_TOKEN || fromFile('upload-token');
export const adminToken = () => process.env.RATER_ADMIN_TOKEN || fromFile('admin-token');

// Is the deployed usage server the one in this repository? Its /v1/health names a hash of its
// server/index.mjs (`server`); one deployed before it did names none. `local`: this checkout's
// hash (SERVER_HASH). same | different (another version is running) | unreachable.
export async function checkServer(base, local, fetchImpl = fetch) {
  let body;
  try {
    const res = await fetchImpl(new URL('/v1/health', base));
    if (!res.ok) return { status: 'unreachable', detail: `answered ${res.status}` };
    body = await res.json();
  } catch (e) {
    return { status: 'unreachable', detail: String(e.message ?? e).slice(0, 120) };
  }
  const deployed = typeof body?.server === 'string' ? body.server : null;
  return { status: deployed === local ? 'same' : 'different', deployed, local };
}
