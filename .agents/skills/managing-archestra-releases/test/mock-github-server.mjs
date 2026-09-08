import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

export async function startMockGithub({ scenario = "fresh" } = {}) {
  const state = initialState(scenario);
  const secret = randomBytes(24).toString("hex");
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    try {
      if (request.url === "/health") return send(response, 200, { ok: true });
      if (request.url === "/tool" && request.method === "POST") return send(response, 200, runTool(state, body));
      if (request.url === "/operator" && request.method === "POST") {
        requireSecret(request, secret);
        return send(response, 200, operatorAction(state, body.action));
      }
      if (request.url === "/snapshot" && request.method === "GET") {
        requireSecret(request, secret);
        return send(response, 200, structuredClone(state));
      }
      throw new HarnessError(404, "not found");
    } catch (error) {
      send(response, error instanceof HarnessError ? error.status : 500, {
        error: error.message,
      });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    secret,
    async operator(action) {
      return requestJson(`${url}/operator`, { action }, secret);
    },
    async snapshot() {
      return requestJson(`${url}/snapshot`, undefined, secret, "GET");
    },
    async stop() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function initialState(scenario) {
  const state = {
    scenario,
    phase: "preflight",
    permissions: { rulesets: true, environments: true, releases: true },
    approvals: { stableCut: false, environment: false, nextBeta: false, recovery: false, retry: false },
    coreRuleset: { id: 101, doNotEnforceOnCreate: false, active: true },
    branches: { main: "main-sha", "release/1.3": "stable-1.3" },
    tags: { "platform-v1.4.0-beta.2": "beta-1.4" },
    policies: ["release/1.3"],
    rulesets: [{ id: 102, name: "release/1.3 queue", ref: "release/1.3", kind: "queue" }],
    prs: [{ number: 1, type: "old-release", state: "OPEN", base: "release/1.3" }],
    releases: [{ tag: "platform-v1.3.52", draft: false, prerelease: false }],
    runs: [],
    artifacts: { runId: 900, verified: false, freshRetryVerified: false },
    events: [],
  };

  if (scenario === "permission-denied") state.permissions.rulesets = false;
  if (scenario === "rules-drift") state.coreRuleset.doNotEnforceOnCreate = true;
  if (scenario === "busy-old-line") state.oldLineBusy = true;
  if (scenario === "branch-create-failure") state.branchCreateFails = true;
  if (scenario === "resume") {
    state.phase = "qualifying";
    state.approvals.stableCut = true;
    state.branches["release/1.4"] = "beta-1.4";
    state.rulesets.push({ id: 103, name: "release/1.4 queue", ref: "release/1.4", kind: "queue" });
    state.policies.push("release/1.4");
    state.prs.push(
      { number: 2, type: "stable-config", state: "MERGED", base: "release/1.4" },
      { number: 3, type: "stable-release", state: "MERGED", base: "release/1.4" },
    );
    state.releases.push({ tag: "platform-v1.4.0", draft: true, prerelease: false });
    state.runs.push({ id: 900, branch: "release/1.4", status: "waiting", artifacts: "candidate-140" });
  }
  if (scenario === "failed-qualification") {
    state.phase = "qualification-failed";
    state.branches["release/1.4"] = "beta-1.4";
    state.rulesets.push({ id: 103, name: "release/1.4 queue", ref: "release/1.4", kind: "queue" });
    state.policies.push("release/1.4");
    state.releases.push({ tag: "platform-v1.4.0", draft: true, prerelease: false });
    state.runs.push({ id: 900, branch: "release/1.4", status: "failed", artifacts: "candidate-140" });
  }
  if (scenario === "partial-publication") {
    state.phase = "partial-publication";
    state.branches["release/1.4"] = "beta-1.4";
    state.releases.push({ tag: "platform-v1.4.1", draft: true, prerelease: false });
    state.runs.push({ id: 900, branch: "release/1.4", status: "failed", artifacts: "candidate-141" });
  }
  if (scenario === "stable-backport") {
    state.branches["release/1.4"] = "stable-1.4";
    state.mainCommits = ["main-fix"];
  }
  if (scenario === "shifted-pr-numbers") {
    state.prs.push({ number: 200, type: "unrelated", state: "CLOSED", base: "main" });
  }
  return state;
}

function runTool(state, { tool, args = [] }) {
  if (tool === "gh") return runGh(state, args);
  if (tool === "git") return runGit(state, args);
  throw new HarnessError(400, `unsupported tool: ${tool}`);
}

function runGh(state, args) {
  const [group, command] = args;
  if (group === "api") return runApi(state, args.slice(1));
  if (group === "pr") return runPr(state, command, args.slice(2));
  if (group === "run" && command === "download") return downloadArtifacts(state, args.slice(2));
  if (group === "run" && command === "rerun") return rerun(state, args.slice(2));
  throw new HarnessError(400, `unsupported gh command: ${args.join(" ")}`);
}

function runApi(state, args) {
  const { endpoint, method, fields } = parseApi(args);
  event(state, "api", { method, endpoint, fields });
  if (endpoint.includes("rulesets")) requirePermission(state, "rulesets");
  if (endpoint.includes("environments")) requirePermission(state, "environments");
  if (endpoint.includes("releases")) requirePermission(state, "releases");
  if (method === "GET") {
    if (state.oldLineBusy) throw new HarnessError(409, "previous stable workflow is busy");
    if (endpoint.endsWith("rulesets") && state.coreRuleset.doNotEnforceOnCreate) throw new HarnessError(409, "ruleset drift: branch creation exemption is already enabled");
    return apiResponse(state, endpoint);
  }
  if (endpoint.endsWith("rulesets/101") && method === "PATCH") {
    const enabled = fields.do_not_enforce_on_create === "true";
    state.coreRuleset.doNotEnforceOnCreate = enabled;
    event(state, enabled ? "core-exemption-enabled" : "core-exemption-restored");
    return { id: 101, do_not_enforce_on_create: enabled };
  }
  if (endpoint.endsWith("rulesets") && method === "POST") {
    if (fields.name?.includes("queue")) {
      ensure(state.branches["release/1.4"], "target branch is missing");
      ensure(!state.coreRuleset.doNotEnforceOnCreate, "core ruleset must be restored before queue creation");
      state.rulesets.push({ id: nextRulesetId(state), name: fields.name, ref: fields.included?.replace("refs/heads/", ""), kind: "queue" });
      event(state, "target-queue-created");
      return { id: state.rulesets.at(-1).id };
    }
    if (fields.name?.includes("EOL")) {
      ensure(!state.rulesets.some((item) => item.kind === "queue" && item.ref === "release/1.3"), "old queue must be removed first");
      state.rulesets.push({ id: nextRulesetId(state), name: fields.name, ref: "release/1.3", kind: "eol" });
      event(state, "old-line-locked");
      return { id: state.rulesets.at(-1).id };
    }
  }
  if (endpoint.includes("deployment-branch-policies") && method === "POST") {
    ensure(fields.name === "release/1.4", "only the new stable line can be added");
    if (!state.policies.includes(fields.name)) state.policies.push(fields.name);
    event(state, "new-policy-added");
    return { name: fields.name };
  }
  if (endpoint.includes("deployment-branch-policies/release%2F1.3") && method === "DELETE") {
    state.policies = state.policies.filter((policy) => policy !== "release/1.3");
    event(state, "old-policy-removed");
    return {};
  }
  if (endpoint.endsWith("rulesets/102") && method === "DELETE") {
    state.rulesets = state.rulesets.filter((item) => item.id !== 102);
    event(state, "old-queue-removed");
    return {};
  }
  if (endpoint.includes("pending_deployments")) throw new HarnessError(403, "environment approval is an operator action");
  throw new HarnessError(404, `unsupported endpoint: ${method} ${endpoint}`);
}

function runGit(state, args) {
  if (args[0] === "push") {
    const refspec = args.at(-1);
    if (refspec === "refs/tags/platform-v1.4.0-beta.2:refs/heads/release/1.4") {
      ensure(state.approvals.stableCut, "stable-cut approval is required");
      ensure(state.coreRuleset.doNotEnforceOnCreate, "branch creation exemption is required by this fixture");
      if (state.branchCreateFails) throw new HarnessError(422, "simulated branch creation failure");
      state.branches["release/1.4"] = state.tags["platform-v1.4.0-beta.2"];
      event(state, "stable-branch-created", { source: "platform-v1.4.0-beta.2" });
      return { ok: true };
    }
  }
  if (args[0] === "cherry-pick") {
    ensure(args.includes("-x") && state.mainCommits?.includes(args.at(-1)), "backports must cherry-pick a main commit with -x");
    event(state, "backport-created", { commit: args.at(-1) });
    return { ok: true };
  }
  if (args[0] === "merge" && args.at(-1) === "main") throw new HarnessError(422, "main must not merge directly into a release branch");
  throw new HarnessError(400, `unsupported git command: ${args.join(" ")}`);
}

function runPr(state, command, args) {
  if (command === "create") {
    const title = valueAfter(args, "--title") ?? "";
    const base = valueAfter(args, "--base") ?? "main";
    const type = prType(state, title);
    ensure(canCreatePr(state, type), `cannot create ${type} PR during ${state.phase}`);
    const pr = { number: nextPrNumber(state), type, state: "OPEN", base };
    state.prs.push(pr);
    event(state, "pr-created", { number: pr.number, type });
    return { url: `https://mock.invalid/pull/${pr.number}`, number: pr.number };
  }
  if (command === "merge") {
    const pr = state.prs.find((item) => item.number === prNumber(args));
    ensure(pr?.state === "OPEN", "open PR not found");
    pr.state = "MERGED";
    event(state, "pr-merged", { number: pr.number, type: pr.type });
    const generatedPr = advanceMergedPr(state, pr);
    return { merged: true, generatedPr: generatedPr?.number };
  }
  if (command === "close") {
    const pr = state.prs.find((item) => item.number === prNumber(args));
    ensure(pr?.state === "OPEN", "open PR not found");
    if (pr.type === "old-release") {
      ensure(state.phase === "qualifying" && state.artifacts.verified, "previous-line PR can close only after candidate artifacts are verified");
    }
    pr.state = "CLOSED";
    event(state, "pr-closed", { number: pr.number, type: pr.type });
    return { closed: true };
  }
  throw new HarnessError(400, `unsupported pr command: ${command}`);
}

function advanceMergedPr(state, pr) {
  if (pr.type === "stable-config") {
    state.phase = "release-pr";
    const generatedPr = { number: nextPrNumber(state), type: "stable-release", state: "OPEN", base: "release/1.4" };
    state.prs.push(generatedPr);
    event(state, "release-pr-generated", { version: "1.4.0" });
    return generatedPr;
  } else if (pr.type === "stable-release") {
    state.phase = "qualifying";
    state.releases.push({ tag: "platform-v1.4.0", draft: true, prerelease: false });
    state.runs.push({ id: 900, branch: "release/1.4", status: "waiting", artifacts: "candidate-140" });
    event(state, "candidate-created", { version: "1.4.0" });
  } else if (pr.type === "recovery-config") {
    state.phase = "recovery-release-pr";
    const generatedPr = { number: nextPrNumber(state), type: "recovery-release", state: "OPEN", base: "release/1.4" };
    state.prs.push(generatedPr);
    return generatedPr;
  } else if (pr.type === "recovery-release") {
    state.phase = "qualifying";
    state.releases.push({ tag: "platform-v1.4.1", draft: true, prerelease: false });
    state.runs.push({ id: 901, branch: "release/1.4", status: "waiting", artifacts: "candidate-141" });
    event(state, "candidate-created", { version: "1.4.1" });
  } else if (pr.type === "stable-cleanup") {
    state.phase = "next-beta-approval";
  } else if (pr.type === "beta-config") {
    state.phase = "beta-release-pr";
    const generatedPr = { number: nextPrNumber(state), type: "beta-release", state: "OPEN", base: "main" };
    state.prs.push(generatedPr);
    return generatedPr;
  } else if (pr.type === "beta-release") {
    state.phase = "beta-published";
    state.releases.push({ tag: "platform-v1.5.0-beta.1", draft: false, prerelease: true });
    event(state, "beta-published", { latestMoved: false });
  } else if (pr.type === "beta-cleanup") {
    state.phase = "done";
    event(state, "rolling-beta-resumed", { next: "1.5.0-beta.2" });
  }
}

function downloadArtifacts(state, args) {
  const runId = Number(args[0]);
  ensure(Number.isInteger(runId), "release run ID is required");
  const run = state.runs.find((item) => item.id === runId);
  ensure(run, "release run not found");
  if (state.phase === "partial-publication") state.artifacts.freshRetryVerified = true;
  else state.artifacts.verified = true;
  event(state, "artifacts-downloaded", { runId: run.id, artifacts: run.artifacts });
  return { runId: run.id, artifacts: run.artifacts };
}

function rerun(state, args) {
  const runId = Number(args[0]);
  ensure(runId === 900, "partial publication must rerun the original workflow");
  const run = state.runs.find((item) => item.id === runId);
  ensure(state.phase === "partial-publication" && run?.status === "failed", "only a failed partial publication can rerun here");
  ensure(state.artifacts.freshRetryVerified, "fresh artifact verification is required");
  ensure(state.approvals.retry, "fresh operator authorization is required");
  run.status = "waiting";
  state.phase = "qualifying";
  event(state, "run-rerun", { runId: 900 });
  return { rerun: 900 };
}

function operatorAction(state, action) {
  if (action === "approve-stable-cut") {
    ensure(state.phase === "preflight", "stable cut is not awaiting approval");
    state.approvals.stableCut = true;
    state.phase = "stable-approved";
  } else if (action === "deny-stable-cut") {
    ensure(state.phase === "preflight", "stable cut is not awaiting approval");
    state.phase = "stable-denied";
  } else if (action === "approve-environment") {
    ensure(state.phase === "qualifying" && state.artifacts.verified, "qualified candidate is not awaiting approval");
    state.approvals.environment = true;
    state.phase = "published";
    const release = state.releases.at(-1);
    release.draft = false;
    event(state, "operator-approved-environment");
  } else if (action === "approve-next-beta") {
    ensure(state.phase === "next-beta-approval", "next beta is not awaiting approval");
    state.approvals.nextBeta = true;
    state.phase = "next-beta-approved";
  } else if (action === "authorize-recovery") {
    ensure(state.phase === "qualification-failed", "recovery is not awaiting authorization");
    state.approvals.recovery = true;
    state.phase = "recovery-authorized";
    event(state, "operator-authorized-recovery");
  } else if (action === "approve-retry") {
    ensure(state.phase === "partial-publication" && state.artifacts.freshRetryVerified, "retry requires fresh artifact verification");
    state.approvals.retry = true;
    event(state, "operator-approved-retry");
  } else {
    throw new HarnessError(400, `unknown operator action: ${action}`);
  }
  event(state, "operator-action", { action });
  return { ok: true, phase: state.phase };
}

function parseApi(args) {
  let method = "GET";
  let endpoint;
  const fields = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["-X", "--method"].includes(arg)) {
      const value = args[++index];
      ensure(value, `gh api option ${arg} requires a value`);
      method = value.toUpperCase();
      continue;
    }
    if (["-f", "-F", "--raw-field"].includes(arg)) {
      const field = args[++index];
      ensure(field?.includes("="), `gh api option ${arg} requires key=value`);
      const [key, ...value] = field.split("=");
      fields[key] = value.join("=");
      continue;
    }
    if (["-H", "--header", "--input"].includes(arg)) {
      ensure(args[++index], `gh api option ${arg} requires a value`);
      continue;
    }
    if (!arg.startsWith("-") && !endpoint) endpoint = arg;
  }
  ensure(endpoint, "gh api endpoint is required");
  return { endpoint, method, fields };
}

function apiResponse(state, endpoint) {
  if (endpoint.endsWith("rulesets")) return [{ id: 101, name: "release core", do_not_enforce_on_create: state.coreRuleset.doNotEnforceOnCreate }, ...state.rulesets];
  if (endpoint.includes("stable-release")) return { policies: state.policies, prevent_self_review: true, can_admins_bypass: false };
  return { ok: true };
}

function prType(state, title) {
  if (title.includes("stable configuration")) return state.phase === "recovery-authorized" ? "recovery-config" : "stable-config";
  if (title.includes("stable cleanup")) return "stable-cleanup";
  if (title.includes("beta configuration")) return "beta-config";
  if (title.includes("beta cleanup")) return "beta-cleanup";
  if (title.includes("backport")) return "backport";
  throw new HarnessError(400, `unrecognized PR title: ${title}`);
}

function canCreatePr(state, type) {
  return (type === "stable-config" && state.phase === "stable-approved")
    || (type === "recovery-config" && state.phase === "recovery-authorized")
    || (type === "stable-cleanup" && state.phase === "published")
    || (type === "beta-config" && state.phase === "next-beta-approved")
    || (type === "beta-cleanup" && state.phase === "beta-published")
    || (type === "backport" && state.scenario === "stable-backport");
}

function requirePermission(state, permission) { if (!state.permissions[permission]) throw new HarnessError(403, `${permission} permission denied`); }
function ensure(condition, message) { if (!condition) throw new HarnessError(409, message); }
function event(state, type, details = {}) { state.events.push({ type, ...details }); }
function nextPrNumber(state) { return Math.max(100, ...state.prs.map((pr) => pr.number)) + 1; }
function nextRulesetId(state) { return Math.max(102, ...state.rulesets.map((ruleset) => ruleset.id)) + 1; }
function prNumber(args) { return Number(args.find((arg) => /^#?\d+$/.test(arg))?.replace("#", "")); }
function valueAfter(args, flag) { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; }

class HarnessError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function readJson(request) {
  if (["GET", "HEAD"].includes(request.method)) return {};
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function requireSecret(request, secret) { if (request.headers["x-release-harness-secret"] !== secret) throw new HarnessError(403, "operator authority required"); }
function send(response, status, body) { response.writeHead(status, { "content-type": "application/json" }); response.end(`${JSON.stringify(body)}\n`); }
async function requestJson(url, body, secret, method = "POST") {
  const response = await fetch(url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), "x-release-harness-secret": secret }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}
