import fs from 'fs';
import ts from 'typescript';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');

const regex = /^```typescript\r?\n([\s\S]*?)\r?\n```/gm;
let match;
const tsBlocks = [];

while ((match = regex.exec(content)) !== null) {
  tsBlocks.push({ index: tsBlocks.length + 1, code: match[1] });
}

console.log(`Analyzing ${tsBlocks.length} TypeScript code blocks...`);

let tsErrors = 0;
tsBlocks.forEach((b) => {
  const sourceFile = ts.createSourceFile(
    `block_${b.index}.ts`,
    b.code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  // Check syntactic diagnostics
  // @ts-ignore
  const diagnostics = sourceFile.parseDiagnostics || [];
  if (diagnostics.length > 0) {
    tsErrors += diagnostics.length;
    console.error(`TS Block ${b.index} has ${diagnostics.length} syntax diagnostics:`);
    diagnostics.forEach((d) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(d.start || 0);
      console.error(`  Line ${line + 1}:${character + 1} - ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    });
  } else {
    console.log(`TS Block ${b.index}: OK (0 syntax errors, ${sourceFile.statements.length} AST statements)`);
  }
});

console.log(`Total TS syntax errors: ${tsErrors}`);
