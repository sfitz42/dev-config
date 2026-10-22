/**
 * Writes schema.json from the TypeBox config schema. Run with
 * `node scripts/write-schema.ts`; `--check` exits 1 if the file is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { guardrailsConfigSchema } from '../src/config/config-schema.ts'

const target = new URL('../schema.json', import.meta.url)
const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Guardrails settings',
  ...guardrailsConfigSchema
}
const text = `${JSON.stringify(schema, null, 2)}\n`

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(target, 'utf8')
  } catch {}
  if (current !== text) {
    console.error('schema.json is out of date; run node scripts/write-schema.ts')
    process.exit(1)
  }
} else {
  writeFileSync(target, text)
}
