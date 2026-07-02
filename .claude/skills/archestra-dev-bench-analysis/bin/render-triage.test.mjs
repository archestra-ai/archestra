// Tests for render-triage.mjs: golden-fixture parity with the Rust analyzer
// (shared fixture under archestra-bench/analyzer/tests/fixtures/triage_golden)
// plus local negative/rendering cases. Run: node --test bin/render-triage.test.mjs
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  buildAnalysesDoc,
  collectTriage,
  parseJudgment,
  renderSection,
  stampRecord,
  truncateChars,
} from './render-triage.mjs'

const validJudgment = () => ({
  verdict: 'minor friction — one schema retry',
  rubrics: {
    knowledge: { grade: 4, comment: 'Knew the schema.' },
    reasoning: { grade: 3, comment: 'One detour.' },
    instruction_following: { grade: 5, comment: 'Followed format.' },
    env_ergonomics: { grade: 2, comment: 'Opaque error.' },
  },
  reward_hacking: { suspected: false, evidence: null },
  observations: ['re-fetched the same file twice'],
})

// --- golden fixture parity (shared with the Rust analyzer; a missing fixture is a FAILURE:
//     parity must never silently degrade to "skipped") ---

const repoRoot = execSync('git rev-parse --show-toplevel', {
  cwd: dirname(fileURLToPath(import.meta.url)),
  encoding: 'utf8',
}).trim()
const fixtureDir = join(repoRoot, 'archestra-bench', 'analyzer', 'tests', 'fixtures', 'triage_golden')

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

// --- parse/validation (contract §1) ---

test('valid judgment parses', () => {
  const parsed = parseJudgment(JSON.stringify(validJudgment()))
  assert.equal(parsed.rubrics.knowledge.grade, 4)
})

test('grade 0 and 6 are rejected', () => {
  for (const grade of [0, 6]) {
    const judgment = validJudgment()
    judgment.rubrics.reasoning.grade = grade
    assert.throws(() => parseJudgment(JSON.stringify(judgment)), /reasoning\.grade/)
  }
})

test('missing rubric key is rejected', () => {
  const judgment = validJudgment()
  delete judgment.rubrics.env_ergonomics
  assert.throws(() => parseJudgment(JSON.stringify(judgment)), /env_ergonomics/)
})

test('fenced reply is accepted', () => {
  const body = JSON.stringify(validJudgment())
  for (const fenced of ['```json\n' + body + '\n```', '```\n' + body + '\n```\n']) {
    assert.equal(parseJudgment(fenced).verdict, validJudgment().verdict)
  }
})

test('observations over 6 entries or non-array are rejected', () => {
  const tooMany = validJudgment()
  tooMany.observations = Array(7).fill('x')
  assert.throws(() => parseJudgment(JSON.stringify(tooMany)), /at most 6/)
  const nonArray = validJudgment()
  nonArray.observations = 'nope'
  assert.throws(() => parseJudgment(JSON.stringify(nonArray)), /array/)
})

// --- directory validation against order.tsv ---

const orderRows = [
  { idx: 0, id: 'basic/a__lane', outcome: 'passed' },
  { idx: 1, id: 'basic/b__lane', outcome: 'failed' },
]

function triageDirWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'render-triage-test-'))
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

test('missing index is detected', () => {
  const dir = triageDirWith({ '00.json': JSON.stringify(validJudgment()) })
  const { problems } = collectTriage(orderRows, dir)
  assert.deepEqual(problems.missing, [1])
  assert.deepEqual(problems.extra, [])
  assert.deepEqual(problems.invalid, [])
})

test('extra/stale numbered json is detected; non-judgment files are ignored', () => {
  const dir = triageDirWith({
    '00.json': JSON.stringify(validJudgment()),
    '01.json': JSON.stringify(validJudgment()),
    '02.json': JSON.stringify(validJudgment()),
    'notes.txt': 'not a triage file',
  })
  const { records, problems } = collectTriage(orderRows, dir)
  assert.deepEqual(problems.extra, ['02.json'])
  assert.deepEqual(problems.missing, [])
  assert.equal(records.length, 2)
})

test('invalid judgment is reported with its index; stamping uses order.tsv', () => {
  const bad = validJudgment()
  bad.rubrics.knowledge.grade = 9
  const dir = triageDirWith({
    '00.json': JSON.stringify({ ...validJudgment(), rollout: 'model/spoofed', outcome: 'passed' }),
    '01.json': JSON.stringify(bad),
  })
  const { records, problems } = collectTriage(orderRows, dir)
  assert.equal(problems.invalid.length, 1)
  assert.equal(problems.invalid[0].idx, 1)
  assert.match(problems.invalid[0].error, /knowledge\.grade/)
  assert.equal(records[0].rollout, 'basic/a__lane')
  assert.equal(records[0].outcome, 'passed')
})

// --- section rendering (contract §3) ---

const rubricLines =
  '- knowledge: 4/5 — Knew the schema.\n' +
  '- reasoning: 3/5 — One detour.\n' +
  '- instruction_following: 5/5 — Followed format.\n' +
  '- env_ergonomics: 2/5 — Opaque error.'

test('reward-hacking line rendering rules', () => {
  const record = stampRecord(validJudgment(), 'r', 'failed')
  const base = 'minor friction — one schema retry\n\n' + rubricLines
  const observations = '\n\nObservations:\n- re-fetched the same file twice'
  assert.equal(renderSection(record), base + observations)

  record.reward_hacking = { suspected: true, evidence: 'hardcoded expected output' }
  assert.equal(
    renderSection(record),
    base + '\n- reward hacking: SUSPECTED — hardcoded expected output' + observations,
  )

  record.reward_hacking = { suspected: true, evidence: null }
  assert.equal(renderSection(record), base + '\n- reward hacking: SUSPECTED' + observations)
})

test('observations block is omitted when empty', () => {
  const judgment = validJudgment()
  judgment.observations = []
  const section = renderSection(stampRecord(judgment, 'r', 'failed'))
  assert.equal(section, 'minor friction — one schema retry\n\n' + rubricLines)
})

test('record key order is the contract order', () => {
  const record = stampRecord(validJudgment(), 'r', 'failed')
  assert.deepEqual(Object.keys(record), ['rollout', 'outcome', 'verdict', 'rubrics', 'reward_hacking', 'observations'])
  assert.deepEqual(Object.keys(record.rubrics), ['knowledge', 'reasoning', 'instruction_following', 'env_ergonomics'])
  assert.deepEqual(Object.keys(record.rubrics.knowledge), ['grade', 'comment'])
  assert.deepEqual(Object.keys(record.reward_hacking), ['suspected', 'evidence'])
})

// --- truncation (Rust truncate_chars parity) ---

test('bodies of 6000 chars or fewer are untouched; longer get cut + marker', () => {
  const exact = 'x'.repeat(6000)
  assert.equal(truncateChars(exact), exact)
  const long = 'y'.repeat(6001)
  assert.equal(truncateChars(long), 'y'.repeat(6000) + '\n[analysis truncated]')
})

// --- doc assembly shape ---

test('analyses doc: metrics head, per-rollout heading, blank line, body, blank line', () => {
  const record = stampRecord(validJudgment(), 'basic/a__lane', 'passed')
  const doc = buildAnalysesDoc('metrics line\n', [record])
  assert.equal(doc, 'metrics line\n\n# Per-trajectory analyses\n\n## basic/a__lane — passed\n\n' + renderSection(record) + '\n')
})
