// Reduce grounding phase for the archestra-dev-bench-analysis skill.
// One repo-crawler agent per issue/subsystem, in parallel. Each returns
// file:line evidence; the array comes back to the orchestrator, which
// verifies surprising claims and writes the final report itself.
//
// args (passed verbatim by the caller):
//   {
//     repoRoot:       absolute repo root (e.g. /Users/.../archestra)
//     crawlerSystem:  the verbatim REDUCE crawler system prompt from reference/prompts.md
//     issues:         [{ label, prompt }] — one entry per issue/subsystem to ground,
//                     derived by the orchestrator from the assembled analyses doc
//   }
// returns [{ label, evidence }] in input order.

export const meta = {
  name: 'archestra-bench-crawl',
  description: 'Ground each bench finding: one repo-crawler agent per issue, in parallel',
  phases: [{ title: 'Crawl', detail: 'locate and read the real platform/ and archestra-bench/ code' }],
}

phase('Crawl')
const crawled = await parallel(
  args.issues.map((it) => () =>
    agent(
      `${args.crawlerSystem}\n\nRepo root: ${args.repoRoot}\n\nISSUE TO INVESTIGATE:\n${it.prompt}`,
      { label: it.label, model: 'sonnet', phase: 'Crawl' },
    ).then((evidence) => ({ label: it.label, evidence: evidence || '(crawler returned no result)' })),
  ),
)

return crawled
