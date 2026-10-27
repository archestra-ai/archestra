import { renderSummary } from "../../platform/benchmarks/report.mjs";
import {
  benchmarkMarker,
  isPlatformReleasePr,
  readBenchmarkPayload,
} from "./proxy-benchmark-baseline.mjs";

export const benchmarkDocsPath =
  "docs/pages/admin/performance-benchmarks.md";
export const benchmarkDocsCommit = "docs: update proxy benchmark results";
const blocks = {
  chat: {
    start: "<!-- proxy-benchmark-results:start -->",
    end: "<!-- proxy-benchmark-results:end -->",
    requests: "Concurrent HTTP requests",
  },
  mcp: {
    start: "<!-- mcp-gateway-benchmark-results:start -->",
    end: "<!-- mcp-gateway-benchmark-results:end -->",
    requests: "Concurrent tool calls",
  },
};
const workloads = ["chat", "tools", "stream", "mcp"];
const sha = /^[a-f0-9]{40}$/;

/** Required docs validation holds release PRs out of the queue until codegen lands. */
export async function verifyBenchmarkDocs({ github, context }) {
  const source = context.payload.pull_request;
  if (
    source?.user?.login !== "archestra-ci[bot]" ||
    !isPlatformReleasePr(source, `${context.repo.owner}/${context.repo.repo}`)
  )
    return { ready: true, reason: "Not a platform release PR" };

  const pending = (reason) => ({ ready: false, reason });
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: source.number,
    per_page: 100,
  });
  const saved = comments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      comment.body?.startsWith(benchmarkMarker),
  );
  let payload;
  try {
    payload = readBenchmarkPayload(saved?.body);
  } catch {
    return pending("Benchmark record is invalid");
  }
  const summary = payload?.summary;
  if (
    !sha.test(payload?.gitCommit ?? "") ||
    summary?.gitCommit !== payload.gitCommit ||
    !sha.test(summary?.platformTree ?? "")
  )
    return pending("Waiting for a successful benchmark for this release");

  if (payload.gitCommit !== source.head.sha) {
    const { data: changes } = await github.rest.repos.compareCommits({
      ...context.repo,
      base: payload.gitCommit,
      head: source.head.sha,
    });
    // Tables and screenshots may follow the measured commit. No execution
    // inputs may change, and a truncated comparison cannot establish that.
    if (
      changes.status !== "ahead" ||
      !changes.files?.length ||
      changes.files.length >= 300 ||
      changes.files.some(
        (file) =>
          !file.filename.startsWith("docs/") ||
          (file.previous_filename &&
            !file.previous_filename.startsWith("docs/")),
      )
    )
      return pending(
        "Benchmark predates changes to the release's measured code",
      );
  }
  const { data: measured } = await github.rest.repos.getCommit({
    ...context.repo,
    ref: payload.gitCommit,
  });
  const { data: tree } = await github.rest.git.getTree({
    ...context.repo,
    tree_sha: measured.commit.tree.sha,
  });
  if (
    tree.tree.find(
      (entry) => entry.path === "platform" && entry.type === "tree",
    )?.sha !== summary.platformTree
  )
    return pending(
      "Benchmark source tree does not match its measured revision",
    );

  const { data: file } = await github.rest.repos.getContent({
    ...context.repo,
    path: benchmarkDocsPath,
    ref: source.head.sha,
  });
  if (file.type !== "file" || file.encoding !== "base64" || file.size > 256000)
    throw new Error("Benchmark docs are not a bounded Markdown file");
  const markdown = Buffer.from(file.content, "base64").toString("utf8");
  try {
    if (updateBenchmarkTable(markdown, summary) !== markdown)
      return pending("Waiting for the generated benchmark tables");
  } catch {
    return pending("Benchmark record or generated tables are invalid");
  }
  return { ready: true, reason: `Tables match benchmark ${payload.gitCommit}` };
}

export function updateBenchmarkTable(markdown, summary) {
  renderSummary(summary);
  if (
    !summary.complete ||
    summary.diagnostic ||
    (summary.webWorkers ?? 1) !== 1 ||
    !Number.isInteger(summary.logicalCpus) ||
    summary.logicalCpus <= 0 ||
    !Number.isFinite(summary.memoryGiB) ||
    summary.memoryGiB <= 0 ||
    summary.rows.length !== workloads.length ||
    workloads.some(
      (scenario) => !summary.rows.some((row) => row.scenario === scenario),
    ) ||
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
  if (typeof markdown !== "string" || Buffer.byteLength(markdown) > 256000)
    throw new Error("Benchmark docs must contain exactly one results block");
  let updated = markdown;
  for (const [scenario, { start, end, requests }] of Object.entries(blocks)) {
    // Existing release branches can still carry the former internal LLM table.
    // The pinned public comparison has no such marker and must never be replaced.
    if (scenario === "chat" && !updated.includes(start) && !updated.includes(end))
      continue;
    if (
      updated.split(start).length !== 2 ||
      updated.split(end).length !== 2 ||
      updated.indexOf(start) > updated.indexOf(end)
    )
      throw new Error("Benchmark docs must contain exactly one results block");
    const row = summary.rows.find(
      (candidate) => candidate.scenario === scenario,
    );
    const table = scenario === "mcp" ? [
      "| Gateway | Requests per Second | Median Added Latency | P95 Added Latency | P99 Added Latency |",
      "| --- | ---: | ---: | ---: | ---: |",
      `| Archestra | ${row.requestsPerSecond.toFixed(1)} | ${["p50", "p95", "p99"].map((key) => `${row.overheadMs[key].toFixed(2)} ms`).join(" | ")} |`,
      "",
      `${summary.logicalCpus} vCPU / ~${Math.round(summary.memoryGiB)} GiB RAM; one worker, ${row.concurrency} concurrent calls, ${row.attempted} measured calls and zero errors.`,
    ].join("\n") : [
      `| Runner resources | ${requests} | Median added latency | P95 added latency | P99 added latency |`,
      "| --- | ---: | ---: | ---: | ---: |",
      `| ${summary.logicalCpus} vCPU / ~${Math.round(summary.memoryGiB)} GiB RAM | ${row.concurrency} | ${["p50", "p95", "p99"].map((key) => `${row.overheadMs[key].toFixed(2)} ms`).join(" | ")} |`,
    ].join("\n");
    updated =
      updated.slice(0, updated.indexOf(start) + start.length) +
      `\n${table}\n` +
      updated.slice(updated.indexOf(end));
  }
  return updated;
}

/** Commit the generated tables, using only trusted base-branch code and API data. */
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
    (summary.webWorkers ?? 1) !== 1 ||
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
    // Queue admission can race this optional publication. Keep GitHub's locked
    // head and the measured artifacts; never dequeue or retry the branch write.
    if (
      error.status === 422 &&
      /A pull request for this branch has been added to a merge queue\. Branches that\s+are queued for merging cannot be updated\./.test(
        error.message,
      )
    )
      return "queued; retaining validated benchmark artifacts and the queued head";
    throw error;
  }
  return "updated";
}
