import fs from 'fs';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');

const regex = /^```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)\r?\n```/gm;
let match;
let blockIndex = 0;
const emptyBodies = [];

while ((match = regex.exec(content)) !== null) {
  blockIndex++;
  const lang = match[1] || 'none';
  const code = match[2];
  if (['typescript', 'javascript', 'python'].includes(lang)) {
    // Check for empty braces {} in functions
    const lines = code.split('\n');
    lines.forEach((l, idx) => {
      if (/\bfunction\b.*\{\s*\}/.test(l) || /=>\s*\{\s*\}/.test(l) || /\bclass\b.*\{\s*\}/.test(l)) {
        emptyBodies.push({ blockIndex, lang, line: idx + 1, code: l.trim() });
      }
    });
  }
}

console.log('Empty function/class count:', emptyBodies.length);
emptyBodies.forEach(e => console.log(`Block ${e.blockIndex} (${e.lang}) L${e.line}: ${e.code}`));
