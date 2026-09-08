import { execFileSync } from "node:child_process";

const [scenario] = process.argv.slice(2);

function run(tool, args) {
  return execFileSync(tool, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gh(...args) { return run("gh", args); }
function git(...args) { return run("git", args); }
function pr(title, base) { return JSON.parse(gh("pr", "create", "--title", title, "--base", base)).number; }
function merge(number) { gh("pr", "merge", `#${number}`); }

function preflight() {
  gh("api", "repos/mock/archestra/rulesets");
  gh("api", "repos/mock/archestra/environments/stable-release");
}

function startStable() {
  preflight();
  gh("api", "-X", "PATCH", "repos/mock/archestra/rulesets/101", "-f", "do_not_enforce_on_create=true");
  try {
    git("push", "origin", "refs/tags/platform-v1.4.0-beta.2:refs/heads/release/1.4");
  } finally {
    gh("api", "-X", "PATCH", "repos/mock/archestra/rulesets/101", "-f", "do_not_enforce_on_create=false");
  }
  gh("api", "-X", "POST", "repos/mock/archestra/rulesets", "-f", "name=release/1.4 queue", "-f", "included=refs/heads/release/1.4", "-f", "merge_method=SQUASH");
  gh("api", "-X", "POST", "repos/mock/archestra/environments/stable-release/deployment-branch-policies", "-f", "name=release/1.4");
  const config = pr("chore: stable configuration", "release/1.4");
  merge(config);
  merge(102);
  gh("run", "download", "900");
}

function lockOldLine() {
  gh("pr", "close", "#1");
  gh("api", "-X", "DELETE", "repos/mock/archestra/environments/stable-release/deployment-branch-policies/release%2F1.3");
  gh("api", "-X", "DELETE", "repos/mock/archestra/rulesets/102");
  gh("api", "-X", "POST", "repos/mock/archestra/rulesets", "-f", "name=release/1.3 EOL");
}

function finishStable() { const cleanup = pr("chore: stable cleanup", "release/1.4"); merge(cleanup); }
function startBeta() {
  const config = pr("chore: beta configuration", "main");
  merge(config);
  merge(105);
  const cleanup = pr("chore: beta cleanup", "main");
  merge(cleanup);
}

if (scenario === "preflight") preflight();
else if (scenario === "start-stable") startStable();
else if (scenario === "lock-old-line") lockOldLine();
else if (scenario === "finish-stable") finishStable();
else if (scenario === "start-beta") startBeta();
else if (scenario === "resume") { preflight(); gh("run", "download", "900"); }
else if (scenario === "recover-next-patch") { const config = pr("chore: stable configuration", "release/1.4"); merge(config); merge(102); }
else if (scenario === "retry-partial") { gh("run", "download", "900"); gh("run", "rerun", "900"); }
else if (scenario === "backport") { git("cherry-pick", "-x", "main-fix"); const number = pr("fix: backport", "release/1.4"); merge(number); }
else if (scenario === "direct-main-merge") git("merge", "main");
else if (scenario === "forbidden-environment-approval") gh("api", "-X", "POST", "repos/mock/archestra/actions/runs/900/pending_deployments");
else if (scenario === "direct-state-read") {
  const response = await fetch(`${process.env.RELEASE_HARNESS_URL}/snapshot`);
  if (response.ok) throw new Error("untrusted process read authoritative state");
  process.exitCode = 1;
} else if (scenario === "direct-operator-action") {
  const response = await fetch(`${process.env.RELEASE_HARNESS_URL}/operator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve-environment" }),
  });
  if (response.ok) throw new Error("untrusted process impersonated the operator");
  process.exitCode = 1;
} else throw new Error(`unknown fixture scenario: ${scenario}`);
