import fs from 'fs';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');

const regex = /^```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)\r?\n```/gm;
let match;
let count = 0;
const blocksByType = {};
const jsonBlocks = [];

while ((match = regex.exec(content)) !== null) {
  count++;
  const lang = match[1] || 'none';
  const code = match[2];
  blocksByType[lang] = (blocksByType[lang] || 0) + 1;
  if (lang === 'json') {
    jsonBlocks.push({ index: jsonBlocks.length + 1, code, startOffset: match.index });
  }
}

console.log('Total code blocks:', count);
console.log('Blocks by language:', JSON.stringify(blocksByType, null, 2));
console.log('Found JSON blocks count:', jsonBlocks.length);

let jsonErrors = 0;
jsonBlocks.forEach((b) => {
  try {
    const parsed = JSON.parse(b.code);
    const identifier = parsed.title || parsed['$id'] || parsed.id || (parsed.type ? 'type: ' + parsed.type : Object.keys(parsed).join(', '));
    console.log(`JSON Block ${b.index}: OK (${identifier})`);
  } catch (err) {
    jsonErrors++;
    console.error(`JSON Block ${b.index}: ERROR:`, err.message);
  }
});
console.log('Total JSON parse errors:', jsonErrors);
