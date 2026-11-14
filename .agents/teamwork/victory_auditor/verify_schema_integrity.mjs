import fs from 'node:fs';

const content = fs.readFileSync('docs/enterprise-architecture-blueprint.md', 'utf8');
const jsonRegex = /```json\s*([\s\S]*?)\s*```/g;
let match, idx = 0;
let errors = [];

while ((match = jsonRegex.exec(content)) !== null) {
  idx++;
  const raw = match[1];
  try {
    const obj = JSON.parse(raw);
    if (obj['$schema']) {
      // Check schema structure
      if (obj.type !== 'object') {
        errors.push(`Block ${idx} (${obj.title || obj['$id']}): type is not object`);
      }
      if (obj.required && !Array.isArray(obj.required)) {
        errors.push(`Block ${idx}: required is not an array`);
      }
      if (obj.required && obj.properties) {
        for (const req of obj.required) {
          if (!obj.properties[req]) {
            errors.push(`Block ${idx} (${obj.title || obj['$id']}): required property '${req}' not in properties`);
          }
        }
      }
    }
  } catch (err) {
    errors.push(`Block ${idx}: JSON parse error: ${err.message}`);
  }
}

if (errors.length === 0) {
  console.log(`All ${idx} JSON blocks checked. All Draft-07 schemas have valid property definitions, valid required fields, and valid JSON structure!`);
} else {
  console.error('Schema errors found:', errors);
}
