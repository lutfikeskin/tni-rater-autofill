import fs from 'node:fs';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');
const jsonRegex = /```json\s*([\s\S]*?)\s*```/g;
let match, idx = 0;
while ((match = jsonRegex.exec(content)) !== null) {
  idx++;
  const raw = match[1];
  const obj = JSON.parse(raw);
  const title = obj.title || obj['$id'] || (obj.name ? 'Module manifest: ' + obj.name : 'JSON object');
  console.log(`Block ${idx}: ${title} (schema: ${obj['$schema'] || 'none'})`);
}
