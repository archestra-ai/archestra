import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPlatformReleasePr } from "./proxy-benchmark-baseline.mjs";
import {
  benchmarkDocsPath,
  updateBenchmarkTable,
} from "./update-proxy-benchmark-docs.mjs";

export const receiptPath = "docs/release-generation.json";
export const generationCommit = "docs: generate release artifacts";
export const generationWorkflow = ".github/workflows/release-pr-generation.yml";
const sha = /^[a-f0-9]{40}$/;
const screenshot =
  /^docs\/assets\/automated_screenshots\/[a-zA-Z0-9_.-]+\.webp$/;
const maxBundleBytes = 80 * 1024 * 1024;
const digest = (data) => createHash("sha256").update(data).digest("hex");
export const blobSha = (data) =>
  createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const allowed = (kind, file) =>
  kind === "openapi"
    ? file === "docs/openapi.json"
    : kind === "screenshots" && screenshot.test(file);
const eligible = (pr, repo) =>
  pr?.user?.login === "archestra-ci[bot]" &&
  isPlatformReleasePr(pr, `${repo.owner}/${repo.repo}`);

function validIdentity(value) {
  return (
    sha.test(value.sourceSha ?? "") &&
    sha.test(value.baseSha ?? "") &&
    Number.isSafeInteger(value.runId) &&
    value.runId > 0 &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt > 0
  );
}

/** Capture only generator-owned regular files; even an unchanged generator emits a bundle. */
export function packBundle({ root, kind, identity }) {
  if (!validIdentity(identity) || !["openapi", "screenshots"].includes(kind))
    throw new Error("Invalid generation identity");
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (git("rev-parse", "HEAD").trim() !== identity.sourceSha)
    throw new Error("Generator checked out a different revision");
  const files = [
    ...new Set(
      [
        ...git("diff", "--name-only", "-z", "HEAD").split("\0"),
        ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
      ].filter((file) => file && !file.startsWith(".generation-policy/")),
    ),
  ].sort();
  const entries = files.map((file) => {
    if (!allowed(kind, file))
      throw new Error(`Unexpected ${kind} output: ${file}`);
    const absolute = path.join(root, file);
    if (!fs.lstatSync(absolute).isFile())
      throw new Error(`Not a regular generated file: ${file}`);
    const data = fs.readFileSync(absolute);
    return {
      path: file,
      sha256: digest(data),
      content: data.toString("base64"),
    };
  });
  const bundle = { schema: 1, kind, ...identity, files: entries };
  if (Buffer.byteLength(JSON.stringify(bundle)) > maxBundleBytes)
    throw new Error("Generated bundle too large");
  return bundle;
}

export function readBundle(bundle, kind, identity) {
  if (
    !validIdentity(identity) ||
    bundle?.schema !== 1 ||
    bundle.kind !== kind ||
    Object.keys(identity).some((key) => bundle[key] !== identity[key]) ||
    !Array.isArray(bundle.files) ||
    bundle.files.length >= 290 ||
    Buffer.byteLength(JSON.stringify(bundle)) > maxBundleBytes
  )
    throw new Error(`Invalid ${kind} bundle provenance`);
  const seen = new Set();
  return bundle.files.map((file) => {
    if (
      !allowed(kind, file.path) ||
      seen.has(file.path) ||
      typeof file.content !== "string"
    )
      throw new Error("Unexpected or duplicate generated path");
    seen.add(file.path);
    const data = Buffer.from(file.content, "base64");
    if (
      data.toString("base64") !== file.content ||
      digest(data) !== file.sha256
    )
      throw new Error("Generated file digest mismatch");
    if (
      kind === "screenshots" &&
      (data.toString("ascii", 0, 4) !== "RIFF" ||
        data.toString("ascii", 8, 12) !== "WEBP")
    )
      throw new Error("Generated screenshot is not WebP");
    return { path: file.path, data };
  });
}

async function readJson({ github, repo, file, ref }) {
  try {
    const { data } = await github.rest.repos.getContent({
      ...repo,
      path: file,
      ref,
    });
    if (
      data.type !== "file" ||
      data.encoding !== "base64" ||
      data.size > 256000
    )
      throw new Error("Invalid bounded JSON file");
    return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

/** Validate the entire diff, rather than trusting the commit subject or a supplied receipt. */
export async function generatedReceipt({
  github,
  context,
  pr = context.payload.pull_request,
}) {
  if (!eligible(pr, context.repo)) return null;
  const receipt = await readJson({
    github,
    repo: context.repo,
    file: receiptPath,
    ref: pr.head.sha,
  });
  if (
    !receipt ||
    receipt.schema !== 1 ||
    !validIdentity(receipt) ||
    !sha.test(receipt.platformTree ?? "") ||
    !Array.isArray(receipt.files)
  )
    return null;
  const { data: commit } = await github.rest.repos.getCommit({
    ...context.repo,
    ref: pr.head.sha,
  });
  if (
    commit.commit.message.split("\n")[0] !== generationCommit ||
    // GitHub signs App-created Git database commits as web-flow, with the
    // authenticated App as author. An unsigned bot email is not provenance.
    commit.author?.login !== "archestra-ci[bot]" ||
    commit.committer?.login !== "web-flow" ||
    commit.commit.verification?.verified !== true ||
    commit.parents?.length !== 1 ||
    commit.parents[0].sha !== receipt.sourceSha
  )
    return null;
  const files = [];
  for (let page = 1; page <= 3; page++) {
    const { data } = await github.rest.repos.getCommit({
      ...context.repo,
      ref: pr.head.sha,
      per_page: 100,
      page,
    });
    if (!Array.isArray(data.files)) return null;
    files.push(...data.files);
    if (data.files.length < 100) break;
  }
  if (
    !files.length ||
    files.length >= 300 ||
    files.some(
      (file) =>
        (![receiptPath, benchmarkDocsPath, "docs/openapi.json"].includes(
          file.filename,
        ) &&
          !screenshot.test(file.filename)) ||
        !["added", "modified"].includes(file.status),
    )
  )
    return null;
  const expected = new Map(receipt.files.map((file) => [file.path, file.blob]));
  if (
    expected.size !== receipt.files.length ||
    expected.size !== files.length - 1 ||
    !files.some((file) => file.filename === receiptPath) ||
    files.some(
      (file) =>
        file.filename !== receiptPath &&
        expected.get(file.filename) !== file.sha,
    )
  )
    return null;
  const { data: parent } = await github.rest.repos.getCommit({
    ...context.repo,
    ref: receipt.sourceSha,
  });
  const { data: tree } = await github.rest.git.getTree({
    ...context.repo,
    tree_sha: parent.commit.tree.sha,
  });
  if (
    tree.tree.find(
      (entry) => entry.path === "platform" && entry.type === "tree",
    )?.sha !== receipt.platformTree
  )
    return null;
  return receipt;
}

export async function selectGeneration({ github, context }) {
  const pr = context.payload.pull_request;
  return (
    eligible(pr, context.repo) && !(await generatedReceipt({ github, context }))
  );
}

/** Queue entry requires successful completion of the exact receipt's workflow attempt. */
export async function verifyGeneration({ github, context }) {
  if (!eligible(context.payload.pull_request, context.repo))
    return { ready: true, reason: "Not a platform release PR" };
  const receipt = await generatedReceipt({ github, context });
  if (!receipt)
    return {
      ready: false,
      reason: "Waiting for the combined release generation commit",
    };
  const { data: run } = await github.rest.actions.getWorkflowRunAttempt({
    ...context.repo,
    run_id: receipt.runId,
    attempt_number: receipt.attempt,
  });
  const pr = context.payload.pull_request;
  return run.path === generationWorkflow &&
    run.event === "pull_request" &&
    run.head_sha === receipt.sourceSha &&
    run.head_branch === pr.head.ref &&
    run.head_repository?.full_name === pr.head.repo.full_name &&
    run.status === "completed" &&
    run.conclusion === "success"
    ? {
        ready: true,
        reason: `Release artifacts generated from ${receipt.sourceSha}`,
      }
    : {
        ready: false,
        reason: "Waiting for successful generation attempt provenance",
      };
}

/** The sole release writer. Call only after all three producer jobs succeed. */
export async function publishGeneration({
  github,
  context,
  openapi,
  screenshots,
  summary,
  results,
}) {
  const source = context.payload.pull_request;
  if (!eligible(source, context.repo)) throw new Error("Ineligible release PR");
  if (
    ["openapi", "screenshots", "benchmark"].some(
      (kind) => results[kind] !== "success",
    )
  )
    throw new Error("Every generator must succeed before publication");
  const identity = {
    sourceSha: source.head.sha,
    baseSha: source.base.sha,
    runId: Number(context.runId),
    attempt: Number(context.runAttempt),
  };
  const entries = [
    ...readBundle(openapi, "openapi", identity),
    ...readBundle(screenshots, "screenshots", identity),
  ];
  if (
    summary?.gitCommit !== identity.sourceSha ||
    !sha.test(summary?.platformTree ?? "")
  )
    throw new Error("Benchmark source differs from generation source");
  const args = { ...context.repo, pull_number: source.number };
  const current = async () => (await github.rest.pulls.get(args)).data;
  const fresh = (pr) =>
    pr.state === "open" &&
    pr.head.sha === source.head.sha &&
    pr.head.ref === source.head.ref &&
    pr.head.repo.full_name === source.head.repo.full_name &&
    pr.base.sha === source.base.sha &&
    pr.base.ref === source.base.ref;
  const latest = await current();
  if (!fresh(latest)) {
    const receipt = await generatedReceipt({ github, context, pr: latest });
    return receipt?.sourceSha === source.head.sha ? "unchanged" : "superseded";
  }
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
    throw new Error("Benchmark platform tree mismatch");
  const { data: docs } = await github.rest.repos.getContent({
    ...context.repo,
    path: benchmarkDocsPath,
    ref: source.head.sha,
  });
  if (docs.type !== "file" || docs.encoding !== "base64" || docs.size > 256000)
    throw new Error("Invalid benchmark docs");
  const before = Buffer.from(docs.content, "base64").toString("utf8");
  const after = updateBenchmarkTable(before, summary); // Retains all #9662 completeness/diagnostic checks.
  if (after !== before)
    entries.push({ path: benchmarkDocsPath, data: Buffer.from(after) });
  if (entries.length >= 299)
    throw new Error("Too many generated files to verify safely");
  const receipt = {
    schema: 1,
    ...identity,
    platformTree: summary.platformTree,
    files: entries.map((entry) => ({
      path: entry.path,
      blob: blobSha(entry.data),
    })),
  };
  entries.push({
    path: receiptPath,
    data: Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
  });
  const nodes = [];
  for (const entry of entries) {
    const { data: blob } = await github.rest.git.createBlob({
      ...context.repo,
      content: entry.data.toString("base64"),
      encoding: "base64",
    });
    if (blob.sha !== blobSha(entry.data))
      throw new Error("GitHub blob digest mismatch");
    nodes.push({
      path: entry.path,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }
  const { data: nextTree } = await github.rest.git.createTree({
    ...context.repo,
    base_tree: parent.commit.tree.sha,
    tree: nodes,
  });
  const { data: commit } = await github.rest.git.createCommit({
    ...context.repo,
    message: generationCommit,
    tree: nextTree.sha,
    parents: [source.head.sha],
  });
  if (!fresh(await current())) return "superseded";
  try {
    await github.rest.git.updateRef({
      ...context.repo,
      ref: `heads/${source.head.ref}`,
      sha: commit.sha,
      force: false,
    });
  } catch (error) {
    if (
      (error.status === 409 || error.status === 422) &&
      !fresh(await current())
    )
      return "superseded";
    if (
      error.status === 422 &&
      /A pull request for this branch has been added to a merge queue\. Branches that\s+are queued for merging cannot be updated\./.test(
        error.message,
      )
    )
      return "queued; retaining generated artifacts and the queued head";
    throw error;
  }
  return "updated";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const identity = {
    sourceSha: process.env.SOURCE_SHA,
    baseSha: process.env.BASE_SHA,
    runId: Number(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  const bundle = packBundle({
    root: process.cwd(),
    kind: process.argv[2],
    identity,
  });
  fs.writeFileSync(process.argv[3], JSON.stringify(bundle));
}
