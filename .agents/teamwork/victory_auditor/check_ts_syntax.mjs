import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

const testDir = '.agents/teamwork/victory_auditor/ts_tests';
const files = fs.readdirSync(testDir).filter(f => f.endsWith('.ts'));

let syntaxErrors = 0;
for (const file of files) {
  const filePath = path.join(testDir, file);
  const code = fs.readFileSync(filePath, 'utf8');
  
  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
    },
    reportDiagnostics: true,
  });

  if (result.diagnostics && result.diagnostics.length > 0) {
    const syntaxDiags = result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
    if (syntaxDiags.length > 0) {
      console.error(`Syntax errors in ${file}:`);
      for (const diag of syntaxDiags) {
        console.error(`  - Line ${diag.file ? diag.file.getLineAndCharacterOfPosition(diag.start).line + 1 : '?'}: ${diag.messageText}`);
      }
      syntaxErrors += syntaxDiags.length;
    }
  }
}

if (syntaxErrors === 0) {
  console.log(`All ${files.length} TypeScript blocks verified: 0 syntax errors!`);
} else {
  console.error(`Found ${syntaxErrors} syntax errors across TypeScript blocks.`);
}
