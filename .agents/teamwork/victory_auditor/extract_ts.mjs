import fs from 'node:fs';
import path from 'node:path';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');
const tsRegex = /```typescript\s*([\s\S]*?)\s*```/g;
let match, idx = 0;

const testDir = '.agents/teamwork/victory_auditor/ts_tests';
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

let combined = '// Auto-generated TypeScript verification file\n';
combined += 'declare const window: any;\n';
combined += 'declare const document: any;\n';
combined += 'declare const globalThis: any;\n';
combined += 'declare const crypto: any;\n';
combined += 'declare const setTimeout: any;\n';
combined += 'declare const clearTimeout: any;\n';
combined += 'declare const performance: any;\n';

while ((match = tsRegex.exec(content)) !== null) {
  idx++;
  const code = match[1];
  const filePath = path.join(testDir, `block_${idx}.ts`);
  fs.writeFileSync(filePath, code);
}
console.log(`Wrote ${idx} individual TS files to ${testDir}`);
