import fs from 'fs';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');
const lines = content.split('\n');

console.log(`Total lines: ${lines.length}`);
console.log(`Total bytes: ${Buffer.byteLength(content, 'utf8')}`);

const headings = [];
lines.forEach((line, i) => {
  const match = line.match(/^(#{1,4})\s+(.*)$/);
  if (match) {
    headings.push({ level: match[1].length, title: match[2], lineNum: i + 1 });
  }
});

console.log(`Found ${headings.length} headings:`);
headings.forEach(h => {
  const indent = '  '.repeat(h.level - 1);
  console.log(`${indent}L${h.lineNum}: [H${h.level}] ${h.title}`);
});
