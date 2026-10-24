import { renderSummary } from "../../platform/benchmarks/report.mjs";
import { isPlatformReleasePr } from "./proxy-benchmark-baseline.mjs";

export const benchmarkDocsPath =
  "docs/pages/admin/observability/performance-benchmarks.md";
export const benchmarkDocsCommit = "docs: update proxy benchmark results";
const start = "<!-- proxy-benchmark-results:start -->";
const end = "<!-- proxy-benchmark-results:end -->";
const sha = /^[a-f0-9]{40}$/;

export function updateBenchmarkTable(markdown, summary) {
  renderSummary(summary);
  if (
    !summary.complete ||
    summary.diagnostic ||
    !Number.isInteger(summary.logicalCpus) ||
    summary.logicalCpus <= 0 ||
    !Number.isFinite(summary.memoryGiB) ||
    summary.memoryGiB <= 0 ||
    summary.rows.length !== 3 ||
    new Set(summary.rows.map((row) => row.scenario)).size !== 3 ||
    summary.rows.some(
      (row) =>
        row.successPercent !== 100 ||
        !Number.isInteger(row.concurrency) ||
        row.concurrency <= 0 ||
        !Number.isInteger(row.attempted) ||
        row.attempted <= 0 ||
        row.succeeded !== row.attempted ||
        row.requestsPerSecond == null ||
        [row.p50Ms, row.p95Ms, row.p99Ms].some((value) => value == null) ||
        (row.scenario === "stream"
          ? row.firstContentP50Ms == null
          : !row.gatewayMs ||
            ["p50", "p95", "p99"].some((key) => row.overheadMs?.[key] == null)),
    )
  )
    throw new Error(
      "Only complete, successful benchmark tables can update docs",
    );
  if (
    typeof markdown !== "string" ||
    Buffer.byteLength(markdown) > 256000 ||
    markdown.split(start).length !== 2 ||
    markdown.split(end).length !== 2 ||
    markdown.indexOf(start) > markdown.indexOf(end)
  )
    throw new Error("Benchmark docs must contain exactly one results block");
  const request = summary.rows.find((row) => row.scenario === "chat");
  const table = [
    "| Runner resources | Concurrent HTTP requests | Median added latency | P95 added latency | P99 added latency |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| ${summary.logicalCpus} vCPU / ~${Math.round(summary.memoryGiB)} GiB RAM | ${request.concurrency} | ${["p50", "p95", "p99"].map((key) => `${request.overheadMs[key].toFixed(2)} ms`).join(" | ")} |`,
  ].join("\n");
  return (
    markdown.slice(0, markdown.indexOf(start) + start.length) +
    `\n${table}\n` +
    markdown.slice(markdown.indexOf(end))
  );
}

/** Commit one generated table, using only trusted base-branch code and API data. */
export async function commitBenchmarkDocs({
  github,
  context,
  summary,
  benchmarkResult,
}) {
  const source = context.payload.pull_request;
  if (
    !isPlatformReleasePr(
      source,
      `${context.repo.owner}/${context.repo.repo}`,
    ) ||
    source.user?.login !== "archestra-ci[bot]" ||
    benchmarkResult !== "success" ||
    !summary?.complete ||
    summary.diagnostic ||
    summary.gitCommit !== source.head.sha ||
    !sha.test(summary.platformTree)
  )
    return "ineligible";
  const args = { ...context.repo, pull_number: source.number };
  const isCurrent = async () => {
    const { data } = await github.rest.pulls.get(args);
    return (
      data.state === "open" &&
      data.head.sha === source.head.sha &&
      data.head.ref === source.head.ref &&
      data.head.repo.full_name === source.head.repo.full_name
    );
  };
  if (!(await isCurrent())) return "superseded";
  const { data: file } = await github.rest.repos.getContent({
    ...context.repo,
    path: benchmarkDocsPath,
    ref: source.head.sha,
  });
  if (file.type !== "file" || file.encoding !== "base64" || file.size > 256000)
    throw new Error("Benchmark docs are not a bounded Markdown file");
  const markdown = Buffer.from(file.content, "base64").toString("utf8");
  const updated = updateBenchmarkTable(markdown, summary);
  if (updated === markdown) return "unchanged";

  const { data: parent } = await github.rest.repos.getCommit({
    ...context.repo,
    ref: source.head.sha,
  });
  const { data: tree } = await github.rest.git.getTree({
    ...context.repo,
    tree_sha: parent.commit.tree.sha,
  });
  if (
    tree.tree.find(
      (entry) => entry.path === "platform" && entry.type === "tree",
    )?.sha !== summary.platformTree
  )
    throw new Error("Benchmark source tree differs from the release PR");
  const { data: nextTree } = await github.rest.git.createTree({
    ...context.repo,
    base_tree: parent.commit.tree.sha,
    tree: [
      {
        path: benchmarkDocsPath,
        mode: "100644",
        type: "blob",
        content: updated,
      },
    ],
  });
  const { data: commit } = await github.rest.git.createCommit({
    ...context.repo,
    message: benchmarkDocsCommit,
    tree: nextTree.sha,
    parents: [source.head.sha],
  });
  if (!(await isCurrent())) return "superseded";
  try {
    // A sibling screenshot or release commit makes this a non-fast-forward.
    // Never force-push over a newer source revision or generated change.
    await github.rest.git.updateRef({
      ...context.repo,
      ref: `heads/${source.head.ref}`,
      sha: commit.sha,
      force: false,
    });
  } catch (error) {
    if ((error.status === 409 || error.status === 422) && !(await isCurrent()))
      return "superseded";
    throw error;
  }
  return "updated";
}
