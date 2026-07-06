// Golden-fixture parity with the Rust analyzer: the one contract worth testing here. The fixture
// (authored by the Rust side under ai-labs/analyzer/tests/fixtures/triage_golden) pins the
// persisted record line and the rendered section to identical bytes across both pipelines.
// Run: node --test bin/render-triage.test.mjs
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { parseJudgment, renderSection, stampRecord } from './render-triage.mjs'

const repoRoot = execSync('git rev-parse --show-toplevel', {
  cwd: dirname(fileURLToPath(import.meta.url)),
  encoding: 'utf8',
}).trim()
const fixtureDir = join(repoRoot, 'ai-labs', 'analyzer', 'tests', 'fixtures', 'triage_golden')

test('golden fixture: stamped record matches record.jsonl byte-exactly', () => {
  const judgment = parseJudgment(readFileSync(join(fixtureDir, 'judgment.json'), 'utf8'))
  const record = stampRecord(judgment, 'basic/sqlite-orders__kimi', 'failed')
  const expectedLine = readFileSync(join(fixtureDir, 'record.jsonl'), 'utf8').split('\n')[0]
  assert.equal(JSON.stringify(record), expectedLine)
})

test('golden fixture: rendered section matches expected_section.md byte-exactly', () => {
  const judgment = parseJudgment(readFileSync(join(fixtureDir, 'judgment.json'), 'utf8'))
  const record = stampRecord(judgment, 'basic/sqlite-orders__kimi', 'failed')
  assert.equal(renderSection(record), readFileSync(join(fixtureDir, 'expected_section.md'), 'utf8'))
})
