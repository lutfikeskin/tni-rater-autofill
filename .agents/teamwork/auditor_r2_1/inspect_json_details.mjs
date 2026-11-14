import fs from 'fs';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');

const regex = /^```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)\r?\n```/gm;
let match;
const jsonBlocks = [];

while ((match = regex.exec(content)) !== null) {
  const lang = match[1] || 'none';
  const code = match[2];
  if (lang === 'json') {
    jsonBlocks.push({ index: jsonBlocks.length + 1, code });
  }
}

jsonBlocks.forEach((b) => {
  const parsed = JSON.parse(b.code);
  const title = parsed.title || parsed['$id'] || parsed.id || 'diagnostic report / object';
  const keys = Object.keys(parsed);
  const propertiesCount = parsed.properties ? Object.keys(parsed.properties).length : 'N/A';
  const requiredCount = parsed.required ? parsed.required.length : 'N/A';
  console.log(`Block ${b.index}: ${title} | schema: ${parsed['$schema'] || 'none'} | type: ${parsed.type || 'object'} | props: ${propertiesCount} | required: ${requiredCount}`);
});
