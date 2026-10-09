import fs from 'node:fs';
import path from 'node:path';
import { zipSync } from 'fflate';

// ZIP entry names always use forward slashes, including on Windows.
export function zipDirectory(directory) {
  const files = {};
  function visit(folder, prefix = '') {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store') continue;
      const name = `${prefix}${entry.name}`;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file, `${name}/`);
      else if (entry.isFile()) files[name] = fs.readFileSync(file);
    }
  }
  visit(directory);
  return zipSync(files, { level: 6 });
}
