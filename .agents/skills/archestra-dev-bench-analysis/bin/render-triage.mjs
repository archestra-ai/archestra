#!/usr/bin/env node
// Deterministic back half of the archestra-dev-bench-analysis skill map phase:
// validate the per-rollout triage judgment JSONs written by workflows/map.mjs,
// stamp rollout/outcome from _prep_claude/order.tsv (never from model output),
// and write the two run artifacts. Implements the shared rubric-triage contract
// byte-for-byte with the Rust analyzer (TriageRecord field order, section
// render, 6000-char truncation marker).
//
// Usage:  render-triage.mjs <RUN_DIR> <TS>     # TS = the prepare.sh TS
//
// Reads  <RUN_DIR>/_prep_claude/{order.tsv,metrics.md} and
//        <RUN_DIR>/_triage_claude/<NN>.json (exactly one per order.tsv index).
// Writes <RUN_DIR>/trajectory_rubrics_claude_<TS>.jsonl (compact, order.tsv order)
//        <RUN_DIR>/trajectory_analyses_claude_<TS>.md
// Emits both paths as KEY=value on stdout. Missing/extra/invalid triage files
// are listed by index on stderr and the script exits non-zero (nothing written).
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUBRIC_KEYS = ['knowledge', 'reasoning', 'instruction_following', 'env_ergonomics']
const SECTION_CHAR_CAP = 6000
const TRUNCATION_MARKER = '\n[analysis truncated]'

export const pad = (idx) => String(idx).padStart(2, '0')

// Parse tolerance (mirrors analyzer/src/rubric.rs `strip_fence` exactly): trim, then strip one
// wrapping fence pair only when the first line is exactly ``` or ```json and the last line is
// exactly ```. Nothing else is salvaged.
export function stripFence(text) {
  const trimmed = text.trim()
  const first = trimmed.indexOf('\n')
  if (first === -1) return trimmed
  const opener = trimmed.slice(0, first)
  if (opener !== '```' && opener !== '```json') return trimmed
  const last = trimmed.lastIndexOf('\n')
  if (last === first) return trimmed
  if (trimmed.slice(last + 1) !== '```') return trimmed
  return trimmed.slice(first + 1, last)
}

// Parse + validate one model-facing judgment object (mirrors analyzer/src/rubric.rs
// `parse_triage`; the golden fixture pins output parity). Throws with a one-line reason on any
// parse or validation failure. Known asymmetry: JSON.parse accepts integral floats (4.0) and
// last-wins duplicate keys where serde rejects both — Rust is the strictly stricter bound, so a
// judgment this rejects is rejected by both pipelines.
export function parseJudgment(text) {
  let value
  try {
    value = JSON.parse(stripFence(text))
  } catch (err) {
    throw new Error(`not valid JSON: ${err.message}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('top level is not a JSON object')
  }
  if (typeof value.verdict !== 'string') throw new Error('verdict must be a string')
  const rubrics = value.rubrics
  if (typeof rubrics !== 'object' || rubrics === null || Array.isArray(rubrics)) {
    throw new Error('rubrics must be an object')
  }
  for (const key of RUBRIC_KEYS) {
    const score = rubrics[key]
    if (typeof score !== 'object' || score === null || Array.isArray(score)) {
      throw new Error(`rubrics.${key} is missing or not an object`)
    }
    if (!Number.isInteger(score.grade) || score.grade < 1 || score.grade > 5) {
      throw new Error(`rubrics.${key}.grade must be an integer 1..=5, got ${JSON.stringify(score.grade)}`)
    }
    if (typeof score.comment !== 'string') throw new Error(`rubrics.${key}.comment must be a string`)
  }
  const rh = value.reward_hacking
  if (typeof rh !== 'object' || rh === null || Array.isArray(rh)) {
    throw new Error('reward_hacking must be an object')
  }
  if (typeof rh.suspected !== 'boolean') throw new Error('reward_hacking.suspected must be a boolean')
  // Absent evidence normalizes to null, matching Rust's Option<String>.
  if (rh.evidence === undefined) rh.evidence = null
  if (rh.evidence !== null && typeof rh.evidence !== 'string') {
    throw new Error('reward_hacking.evidence must be a string or null')
  }
  const obs = value.observations
  if (!Array.isArray(obs)) throw new Error('observations must be an array')
  if (obs.length > 6) throw new Error(`observations must have at most 6 entries, got ${obs.length}`)
  for (const [i, o] of obs.entries()) {
    if (typeof o !== 'string') throw new Error(`observations[${i}] must be a string`)
  }
  return value
}

// Build a persisted TriageRecord in core's TriageRecord field order (JSON.stringify
// preserves insertion order; the golden fixture depends on it). rollout and
// outcome always come from order.tsv, never from the model JSON.
export function stampRecord(judgment, rollout, outcome) {
  const score = (key) => ({ grade: judgment.rubrics[key].grade, comment: judgment.rubrics[key].comment })
  return {
    rollout,
    outcome,
    verdict: judgment.verdict,
    rubrics: {
      knowledge: score('knowledge'),
      reasoning: score('reasoning'),
      instruction_following: score('instruction_following'),
      env_ergonomics: score('env_ergonomics'),
    },
    reward_hacking: { suspected: judgment.reward_hacking.suspected, evidence: judgment.reward_hacking.evidence },
    observations: judgment.observations.slice(),
  }
}

// Section body (mirrors analyzer/src/rubric.rs `render_section`): verdict, blank line, rubric bullets, optional
// reward-hacking line, optional Observations block. No trailing newline.
export function renderSection(record) {
  const lines = [record.verdict, '']
  for (const key of RUBRIC_KEYS) {
    lines.push(`- ${key}: ${record.rubrics[key].grade}/5 — ${record.rubrics[key].comment}`)
  }
  if (record.reward_hacking.suspected) {
    const { evidence } = record.reward_hacking
    lines.push(evidence === null ? '- reward hacking: SUSPECTED' : `- reward hacking: SUSPECTED — ${evidence}`)
  }
  if (record.observations.length > 0) {
    lines.push('', 'Observations:')
    for (const bullet of record.observations) lines.push(`- ${bullet}`)
  }
  return lines.join('\n')
}

// Rust truncate_chars parity: char (code point) count ≤ cap leaves the body
// untouched; otherwise cut at cap chars and append the marker.
export function truncateChars(body, cap = SECTION_CHAR_CAP) {
  const chars = Array.from(body)
  if (chars.length <= cap) return body
  return chars.slice(0, cap).join('') + TRUNCATION_MARKER
}

export function readOrder(orderPath) {
  return readFileSync(orderPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, n) => {
      const [idx, id, outcome] = line.split('\t')
      if (idx === undefined || id === undefined || outcome === undefined || !/^\d+$/.test(idx)) {
        throw new Error(`malformed order.tsv line ${n + 1}: ${JSON.stringify(line)}`)
      }
      return { idx: Number(idx), id, outcome }
    })
}

// order.tsv is the authoritative index set: every index must have exactly its
// <NN>.json, and no other numbered .json may sit in the triage dir.
export function collectTriage(orderRows, triageDir) {
  const expected = new Set(orderRows.map((row) => `${pad(row.idx)}.json`))
  const present = new Set(existsSync(triageDir) ? readdirSync(triageDir) : [])
  const problems = {
    missing: [],
    invalid: [],
    extra: [...present].filter((name) => /^\d+\.json$/.test(name) && !expected.has(name)).sort(),
  }
  const records = []
  for (const row of orderRows) {
    const name = `${pad(row.idx)}.json`
    if (!present.has(name)) {
      problems.missing.push(row.idx)
      continue
    }
    try {
      const judgment = parseJudgment(readFileSync(join(triageDir, name), 'utf8'))
      records.push(stampRecord(judgment, row.id, row.outcome))
    } catch (err) {
      problems.invalid.push({ idx: row.idx, error: err.message })
    }
  }
  return { records, problems }
}

// Same doc shape as the analyzer / the skill's former bash assemble step:
// metrics block, then per rollout `\n## <id> — <outcome>\n\n<capped body>\n`.
export function buildAnalysesDoc(metrics, records) {
  let doc = metrics + '\n# Per-trajectory analyses\n'
  for (const record of records) {
    doc += `\n## ${record.rollout} — ${record.outcome}\n\n${truncateChars(renderSection(record))}\n`
  }
  return doc
}

function main() {
  const [runDirArg, ts] = process.argv.slice(2)
  if (!runDirArg || !ts) {
    console.error('usage: render-triage.mjs <RUN_DIR> <TS>')
    process.exit(2)
  }
  const runDir = resolve(runDirArg)
  const prepDir = join(runDir, '_prep_claude')
  const triageDir = join(runDir, '_triage_claude')

  const orderRows = readOrder(join(prepDir, 'order.tsv'))
  const { records, problems } = collectTriage(orderRows, triageDir)
  if (problems.missing.length + problems.invalid.length + problems.extra.length > 0) {
    if (problems.missing.length > 0) {
      console.error(`missing triage json for indices: ${problems.missing.join(', ')}`)
    }
    for (const { idx, error } of problems.invalid) {
      console.error(`invalid triage json at index ${idx}: ${error}`)
    }
    if (problems.extra.length > 0) {
      console.error(`extra/stale triage files not in order.tsv: ${problems.extra.join(', ')}`)
    }
    console.error('re-run workflows/map.mjs for the missing/invalid indices (and delete extra files), then re-run this script')
    process.exit(1)
  }

  const jsonlPath = join(runDir, `trajectory_rubrics_claude_${ts}.jsonl`)
  const docPath = join(runDir, `trajectory_analyses_claude_${ts}.md`)
  // tmp + rename so the dashboard can never observe a half-written artifact.
  for (const [path, content] of [
    [jsonlPath, records.map((record) => JSON.stringify(record) + '\n').join('')],
    [docPath, buildAnalysesDoc(readFileSync(join(prepDir, 'metrics.md'), 'utf8'), records)],
  ]) {
    writeFileSync(path + '.tmp', content)
    renameSync(path + '.tmp', path)
  }
  console.log(`RUBRICS_JSONL=${jsonlPath}`)
  console.log(`ANALYSES_DOC=${docPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
