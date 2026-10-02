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
