#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const platform = fileURLToPath(new URL("../", import.meta.url));
const usage = "Usage: pnpm enqueue <PR-number> [--repo [HOST/]OWNER/REPO]";

try {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(usage);
  } else {
    enqueue();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function enqueue() {
  const [input, option, repository, ...extra] = process.argv.slice(2);
  if (
    !/^[1-9]\d*$/.test(input ?? "") ||
    !Number.isSafeInteger(Number(input)) ||
    (option !== undefined && (option !== "--repo" || !repository)) ||
    extra.length
  ) {
    throw new Error(usage);
  }
  const target = { number: Number(input), ...resolveRepository(repository) };
  const head = git("rev-parse", "HEAD");
  assertRevision(head);
  const pr = readPullRequest(target);
  assertPullRequest({ pr, head });
  requireMergeQueue({ target, base: pr.baseRefName });

  console.log(`Checking ${pr.url} at ${head} before queue entry.`);
  run({ command: "pnpm", args: ["preflight", head], inherit: true });

  const refreshed = readPullRequest(target);
  assertPullRequest({ pr: refreshed, head });
  if (refreshed.baseRefName !== pr.baseRefName) {
    throw new Error(
      "The PR target branch changed during preflight. Inspect it before retrying.",
    );
  }
  // Refresh the target branch policy after the potentially long preflight.
  requireMergeQueue({ target, base: refreshed.baseRefName });
  assertRevision(head);
  // Queue-only: a concurrent rule change must never turn this into a direct merge.
  graphql({
    target,
    query: `mutation($id:ID!, $head:GitObjectID!) {
      enqueuePullRequest(input:{pullRequestId:$id, expectedHeadOid:$head}) {
        mergeQueueEntry { id }
      }
    }`,
    variables: { id: refreshed.id, head },
  });

  const query = `query($owner:String!, $name:String!, $number:Int!) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$number) {
        state headRefOid
        mergeQueueEntry { position }
      }
    }
  }`;
  const response = graphql({
    target,
    query,
    variables: {
      owner: target.owner,
      name: target.name,
      number: target.number,
    },
  });
  const queued = response?.repository?.pullRequest;
  if (!queued || queued.headRefOid !== head) {
    throw new Error(
      `Could not confirm queue entry for the checked revision. Inspect ${pr.url} before retrying.`,
    );
  }
  if (queued.state === "MERGED") {
    console.log(`Merged ${pr.url} at checked PR revision ${head}.`);
  } else if (queued.mergeQueueEntry) {
    console.log(
      `Queued ${pr.url} at ${head} (position ${queued.mergeQueueEntry.position}). Monitor CI until merged.`,
    );
  } else {
    throw new Error(
      `GitHub has not confirmed queue entry. Inspect ${pr.url} before retrying.`,
    );
  }
}

function resolveRepository(explicit) {
  let parts;
  if (explicit) {
    parts = explicit.split("/");
    if (parts.length === 2) parts.unshift("github.com");
  } else {
    const remote = git("remote", "get-url", "origin");
    let url;
    try {
      url = new URL(remote.replace(/^git@([^:]+):/, "ssh://git@$1/"));
    } catch {
      throw new Error(
        "Cannot resolve origin as a GitHub repository. Pass --repo [HOST/]OWNER/REPO.",
      );
    }
    if (!["https:", "ssh:"].includes(url.protocol)) {
      throw new Error("Unsupported origin URL. Pass --repo [HOST/]OWNER/REPO.");
    }
    parts = [
      url.hostname,
      ...url.pathname
        .replace(/^\//, "")
        .replace(/\.git$/, "")
        .split("/"),
    ];
  }
  if (
    parts.length !== 3 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(parts[0]) ||
    !parts
      .slice(1)
      .every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== "..")
  ) {
    throw new Error("Invalid repository. Use --repo [HOST/]OWNER/REPO.");
  }
  const [host, owner, name] = parts;
  return { host, owner, name, selector: parts.join("/") };
}

function readPullRequest(target) {
  const pr = JSON.parse(
    run({
      command: "gh",
      args: [
        "pr",
        "view",
        String(target.number),
        "--repo",
        target.selector,
        "--json",
        "id,number,url,state,isDraft,headRefOid,baseRefName,mergeable",
      ],
    }),
  );
  if (pr.number !== target.number || !pr.id) {
    throw new Error("GitHub did not return the requested PR identity.");
  }
  return pr;
}

function graphql({ target, query, variables }) {
  return JSON.parse(
    run({
      command: "gh",
      args: [
        "api",
        "graphql",
        "--hostname",
        target.host,
        "-f",
        `query=${query}`,
        ...Object.entries(variables).flatMap(([key, value]) => [
          typeof value === "number" ? "-F" : "-f",
          `${key}=${value}`,
        ]),
      ],
    }),
  ).data;
}

function assertPullRequest({ pr, head }) {
  if (pr.state !== "OPEN" || pr.isDraft || pr.mergeable === "CONFLICTING") {
    throw new Error(
      "The PR must be open, ready for review, and free of merge conflicts before enqueueing.",
    );
  }
  if (pr.headRefOid !== head) {
    throw new Error(
      "Local HEAD does not match the current PR head. Check out the exact revision before enqueueing.",
    );
  }
}

function requireMergeQueue({ target, base }) {
  const rules = JSON.parse(
    run({
      command: "gh",
      args: [
        "api",
        "--hostname",
        target.host,
        `repos/${target.owner}/${target.name}/rules/branches/${encodeURIComponent(base)}`,
      ],
    }),
  );
  if (
    !Array.isArray(rules) ||
    !rules.some((rule) => rule.type === "merge_queue")
  ) {
    throw new Error(
      `The target branch ${base} does not require a merge queue; refusing to enqueue.`,
    );
  }
}

function assertRevision(head) {
  if (
    git("rev-parse", "HEAD") !== head ||
    git("status", "--porcelain", "--untracked-files=normal")
  ) {
    throw new Error(
      "Enqueue requires a clean, unchanged checkout of the checked PR head.",
    );
  }
}

function git(...args) {
  return run({ command: "git", args });
}

function run({ command, args, inherit = false }) {
  const result = spawnSync(command, args, {
    cwd: platform,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ||
        result.stderr?.trim() ||
        `${command} failed; queue entry was not confirmed.`,
    );
  }
  return result.stdout?.trim() ?? "";
}
