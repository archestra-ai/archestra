// Map phase for the archestra-dev-bench-analysis skill.
// One Sonnet triage agent per rollout, fanned out by the Workflow runtime
// (auto-batched at the concurrency cap — no manual 8-at-a-time loop). Each
// agent reads its own trajectory.md and WRITES its triage to a file, so the
// 78 triages never flow back through the orchestrator's context.
//
// args (passed verbatim by the caller):
//   {
//     triageDir:    absolute dir the agents write <NN>.md into (must already exist)
//     mapTemplate:  the verbatim MAP prompt block from reference/prompts.md
//                   (with {ROLLOUT_ID} {OUTCOME_SUMMARY} {TRAJECTORY_MD_PATH} placeholders)
//     rollouts:     manifest order, [{ idx, id, outcome, outcomeSummary, trajectoryMd }]
//   }
// returns { written, total } — counts only; the doc is assembled by the caller from triageDir.

export const meta = {
  name: 'archestra-bench-map',
  description: 'Triage every archestra-bench rollout in parallel; each agent writes its own triage file',
  phases: [{ title: 'Map', detail: 'one Sonnet triage agent per rollout' }],
}

const fill = (t, r) =>
  t
    .replaceAll('{ROLLOUT_ID}', r.id)
    .replaceAll('{OUTCOME_SUMMARY}', r.outcomeSummary)
    .replaceAll('{TRAJECTORY_MD_PATH}', r.trajectoryMd)

const pad = (i) => String(i).padStart(2, '0')

phase('Map')
const res = await parallel(
  args.rollouts.map((r) => () =>
    agent(
      fill(args.mapTemplate, r) +
        `\n\nDELIVERY OVERRIDE: Do NOT return the triage in your reply. Instead use the Write tool ` +
        `to save the triage verbatim (truncate to 6000 characters if longer) to ` +
        `${args.triageDir}/${pad(r.idx)}.md, then reply only with "ok".`,
      { label: r.id, model: 'sonnet', agentType: 'general-purpose', phase: 'Map' },
    ),
  ),
)

log(`map complete: ${res.filter(Boolean).length}/${args.rollouts.length} triage files written`)
return { written: res.filter(Boolean).length, total: args.rollouts.length }
