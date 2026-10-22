import { renderSummary } from "../../platform/benchmarks/report.mjs";

const marker = "<!-- archestra-llm-proxy-benchmark -->";

export async function publishBenchmarkComment({
  github,
  context,
  summary,
  benchmarkResult,
}) {
  const source = context.payload.pull_request;
  if (
    !source ||
    source.head.repo.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
    !source.head.ref.startsWith("release-please--branches--") ||
    !source.head.ref.endsWith("--components--platform")
  )
    return "ineligible";
  const args = { ...context.repo, issue_number: source.number };
  const current = await github.rest.pulls.get({
    ...context.repo,
    pull_number: source.number,
  });
  if (current.data.head.sha !== source.head.sha) return "superseded";
  const runUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  let body = `${marker}\n## LLM Proxy Benchmark\n\nBenchmark did not complete successfully. See the workflow diagnostics.\n`;
  if (
    summary &&
    summary.gitCommit === source.head.sha &&
    (benchmarkResult !== "success" || summary.complete)
  ) {
    try {
      body = `${marker}\n${renderSummary(summary)}`;
      if (benchmarkResult !== "success")
        body += "\nThe workflow failed after or during measurement; inspect its diagnostics.\n";
    } catch {
      body += "\nThe measurement summary was invalid; no performance result is available.\n";
    }
  }
  body += `\nRevision: \`${source.head.sha}\` · [Workflow and measurements](${runUrl})\n`;
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...args,
    per_page: 100,
  });
  const existing = comments.find(
    (c) => c.user?.type === "Bot" && c.body?.startsWith(marker),
  );
  // A newer commit may arrive while comment pages are being read.
  const latest = await github.rest.pulls.get({
    ...context.repo,
    pull_number: source.number,
  });
  if (latest.data.head.sha !== source.head.sha) return "superseded";
  if (existing) {
    await github.rest.issues.updateComment({
      ...context.repo,
      comment_id: existing.id,
      body,
    });
    return "updated";
  }
  await github.rest.issues.createComment({ ...args, body });
  return "created";
}
