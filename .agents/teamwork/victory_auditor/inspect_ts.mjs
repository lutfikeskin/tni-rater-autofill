import fs from 'node:fs';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');
const tsRegex = /```typescript\s*([\s\S]*?)\s*```/g;
let match, idx = 0;

let combinedTs = '';
while ((match = tsRegex.exec(content)) !== null) {
  idx++;
  const code = match[1];
  console.log(`TS block ${idx}: lines=${code.split('\n').length}`);
}
console.log(`Total TypeScript blocks: ${idx}`);
