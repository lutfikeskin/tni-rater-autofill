import fs from 'fs';
import { execSync } from 'child_process';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');

const regex = /^```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)\r?\n```/gm;
let match;
const tsBlocks = [];
const jsBlocks = [];
const pyBlocks = [];

while ((match = regex.exec(content)) !== null) {
  const lang = match[1] || 'none';
  const code = match[2];
  if (lang === 'typescript') tsBlocks.push(code);
  if (lang === 'javascript') jsBlocks.push(code);
  if (lang === 'python') pyBlocks.push(code);
}

console.log(`Found: ${tsBlocks.length} TS blocks, ${jsBlocks.length} JS blocks, ${pyBlocks.length} Python blocks`);

// Test Python blocks
pyBlocks.forEach((code, i) => {
  fs.writeFileSync('.agents/teamwork/auditor_r2_1/temp_py.py', code, 'utf8');
  try {
    execSync('python -m py_compile .agents/teamwork/auditor_r2_1/temp_py.py');
    console.log(`Python Block ${i + 1}: OK (syntactically valid Python)`);
  } catch (err) {
    console.error(`Python Block ${i + 1}: Syntax Error:`, err.message);
  } finally {
    if (fs.existsSync('.agents/teamwork/auditor_r2_1/temp_py.py')) {
      fs.unlinkSync('.agents/teamwork/auditor_r2_1/temp_py.py');
    }
  }
});

// Test JS blocks
jsBlocks.forEach((code, i) => {
  fs.writeFileSync('.agents/teamwork/auditor_r2_1/temp_js.mjs', code, 'utf8');
  try {
    execSync('node --check .agents/teamwork/auditor_r2_1/temp_js.mjs');
    console.log(`JavaScript Block ${i + 1}: OK (syntactically valid JS)`);
  } catch (err) {
    console.error(`JavaScript Block ${i + 1}: Syntax Error:`, err.message);
  } finally {
    if (fs.existsSync('.agents/teamwork/auditor_r2_1/temp_js.mjs')) {
      fs.unlinkSync('.agents/teamwork/auditor_r2_1/temp_js.mjs');
    }
  }
});
