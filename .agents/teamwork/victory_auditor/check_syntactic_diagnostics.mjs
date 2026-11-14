import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

const testDir = '.agents/teamwork/victory_auditor/ts_tests';
const files = fs.readdirSync(testDir).filter(f => f.endsWith('.ts'));

let totalSyntaxErrors = 0;
for (const file of files) {
  const filePath = path.join(testDir, file);
  const code = fs.readFileSync(filePath, 'utf8');

  const sourceFile = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true, // setParentNodes
    ts.ScriptKind.TS
  );

  const program = ts.createProgram({
    rootNames: [filePath],
    options: {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      noEmit: true
    }
  });

  const syntacticDiags = program.getSyntacticDiagnostics(sourceFile);
  if (syntacticDiags.length > 0) {
    console.error(`SYNTAX ERRORS in ${file}:`);
    for (const d of syntacticDiags) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(d.start);
      console.error(`  Line ${line + 1}:${character + 1} - ${d.messageText}`);
    }
    totalSyntaxErrors += syntacticDiags.length;
  } else {
    console.log(`[PASS] ${file}: 0 syntax errors`);
  }
}

console.log(`\nSyntactic verification complete: ${files.length} blocks checked, ${totalSyntaxErrors} syntax errors.`);
