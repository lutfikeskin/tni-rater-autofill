import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');

const regex = /^```typescript\r?\n([\s\S]*?)\r?\n```/gm;
let match;
const tsBlocks = [];

while ((match = regex.exec(content)) !== null) {
  tsBlocks.push(match[1]);
}

console.log(`Found ${tsBlocks.length} TypeScript blocks`);

const tempDir = '.agents/teamwork/auditor_r2_1/temp_ts';
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

tsBlocks.forEach((code, i) => {
  const filePath = path.join(tempDir, `block_${i + 1}.ts`);
  fs.writeFileSync(filePath, code, 'utf8');
});

// Create a minimal tsconfig for syntax checking
const tsconfig = {
  compilerOptions: {
    target: "es2022",
    module: "esnext",
    moduleResolution: "bundler",
    noEmit: true,
    skipLibCheck: true,
    isolatedModules: true
  },
  include: ["block_*.ts"]
};
fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf8');

try {
  console.log('Running tsc --noEmit on extracted TypeScript blocks...');
  const out = execSync(`npx tsc --project ${tempDir}`, { encoding: 'utf8' });
  console.log('TSC output:', out || 'Clean - 0 errors!');
} catch (err) {
  console.log('TSC status code:', err.status);
  console.log('TSC stdout/stderr:\n', err.stdout || err.stderr || err.message);
} finally {
  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true });
}
