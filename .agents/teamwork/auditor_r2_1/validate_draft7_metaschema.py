import re
import json
import sys
from jsonschema import Draft7Validator

with open('docs/enterprise-architecture-blueprint.md', 'r', encoding='utf-8') as f:
    content = f.read()

pattern = r'```json\r?\n([\s\S]*?)\r?\n```'
matches = re.findall(pattern, content)

print(f"Total JSON blocks found: {len(matches)}")

errors = 0
schema_count = 0

for i, raw_json in enumerate(matches, start=1):
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError as e:
        print(f"Block {i}: JSON parse error: {e}")
        errors += 1
        continue

    # Check if it's a JSON Schema (has $schema or type)
    if isinstance(data, dict) and ('$schema' in data or data.get('type') == 'object'):
        if '$schema' in data and 'draft-07' in data['$schema']:
            schema_count += 1
            try:
                Draft7Validator.check_schema(data)
                title = data.get('title') or data.get('$id') or 'Untitled'
                print(f"Block {i} (Draft-07 Schema): PASS -> {title}")
            except Exception as e:
                print(f"Block {i} (Draft-07 Schema): FAIL -> {e}")
                errors += 1
        else:
            print(f"Block {i} (JSON Object / Instance Example): PASS -> keys: {list(data.keys())[:5]}")
    else:
        print(f"Block {i} (Other JSON): PASS")

print(f"\nSummary: {len(matches)} JSON blocks, {schema_count} Draft-07 schemas checked, {errors} errors.")
if errors > 0:
    sys.exit(1)
