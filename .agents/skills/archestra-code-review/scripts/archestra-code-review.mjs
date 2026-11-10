#!/usr/bin/env node
/**
 * On-demand Archestra Code Review runner.
 *
 * Ports the review mode of `archestra-ai/code-review-action` (v0.12.1) and the
 * `.github/workflows/archestra-runtime-review.yml` org workflow so an agent or
 * operator can run the exact same Archestra code review on demand for a local
 * branch or pull request checkout using:
 *   1. A SINGLE MCP gateway connection (the caller's existing `archestra` MCP
 *      gateway from local MCP config or `ARCHESTRA_MCP_GATEWAY_URL`), routing
 *      round-robin across the 5 Lobster Code Review runtime subagents with
 *      automatic failover.
 *   2. A 100% LOCAL-ONLY repository workflow: packages the local repository
 *      checkout at `headSha` directly from disk (`repo-head.tar.gz` + optional
 *      `uncommitted.patch`) and delivers it into `/home/node/workspace/repo`
 *      via inline `start_agent_run` attachments (<= 3 MiB) or a one-off,
 *      short-lived (15-minute), SHA256-pinned `transfer_workspace_file` HTTP
 *      upload ticket (> 3 MiB). Zero GitHub tokens (`gh auth token`, PATs, or
 *      `CODE_REVIEW_GITHUB_TOKEN`) are ever read, transferred, or stored.
 *
 * Outputs both:
 * 1. Structured findings (`agent-findings.json`) for the calling agent/model to
 *    verify against the codebase, triage, and fix.
 * 2. A user-friendly Markdown review report (`chat-report.md`) to display to
 *    the human operator in the model chat.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The 5 runtime subagents in the Lobster Code Review pool, selected via
 * persistent round-robin with automatic failover over the caller's single
 * Archestra MCP gateway connection.
 */
const LOBSTER_CODE_REVIEW_SUBAGENTS = [
  { id: "5ccca2af-4b5c-45f0-b05f-e5160c9103bc", name: "Lobster Code Review Claude Code" },
  { id: "77393a44-a7f2-4d8e-b28f-bc48ccfeca95", name: "Lobster Code Review Codex" },
  { id: "f7c55d1f-d69d-4f4f-b7a3-c8eb9b1ef955", name: "Lobster Code Review Grok" },
  { id: "504b5c4a-0fe7-4344-8e19-5609df890673", name: "Lobster Code Review Kimi" },
  { id: "f4c1274d-d149-4927-8997-9f1b7b8b2b03", name: "Lobster Code Review Copilot" },
];

const AGENT_NAMES_BY_ID = new Map(LOBSTER_CODE_REVIEW_SUBAGENTS.map((a) => [a.id, a.name]));

const PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 35 * 60_000;
const INITIAL_POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;
const POLL_BACKOFF = 1.4;
const MAX_CONSECUTIVE_POLL_ERRORS = 5;
const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_ARCHIVE_BYTES = 3 * 1024 * 1024;
const MAX_EXCERPT_LINES = 12;
const MAX_EXCERPT_CHARS = 1500;
const MAX_RANGE_LINES = 200;

const TERMINAL_STATES = new Set([
  "completed",
  "failed",
  "canceled",
  "rejected",
  "input-required",
  "auth-required",
]);

const SEVERITIES = ["critical", "high", "medium", "low", "nit"];
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 };
const BLOCKING_SEVERITIES = new Set(["critical", "high", "medium"]);
const SEVERITY_LABELS = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  nit: "Nit",
};

const RUN_TOOLS = {
  start: "start_agent_run",
  get: "get_agent_run",
  steer: "steer_agent_run",
  cancel: "cancel_agent_run",
  read: "read_workspace_file",
  write: "write_workspace_file",
  transfer: "transfer_workspace_file",
  delete: "delete_workspace",
};
const ARCHESTRA_PREFIX = "archestra__";
const RUN_TOOL = "run_tool";

// Review brief template adapted from archestra-ai/code-review-action (v0.12.1) src/briefs/review.md
// for 100% local-only workspace snapshot unpacking (no remote GitHub credentials required).
const REVIEW_BRIEF_TEMPLATE = `Review pull request {{prLabel}} ("{{title}}") in {{repo}}.

Do not ask the user any questions. Complete the review and write the output file below.

## Input files

Read the attached files before starting:

- \`pr.json\` — pull request metadata, base/head SHAs, and the list of changed files.
- \`pr.diff\` — the unified diff (may be truncated for very large PRs; see \`diffTruncated\` in \`pr.json\`).
- \`instructions.md\` (when attached) — additional review instructions for this repository.
- \`checks.json\` (when attached) — the GitHub Actions check runs on \`{{headSha}}\` at the start of the review, with their status, conclusion, URL, summary and annotations.
- \`previous-findings.json\` (when attached) — findings from the previous review of this pull request, each with \`id\`, \`file\`, \`line\`, \`severity\`, \`title\`, \`summary\`, \`recommendation\` and \`status\`.

## Procedure

1. Materialize the repository snapshot at \`{{headSha}}\` into \`/home/node/workspace/repo\` so you have the full codebase for context:
   \`\`\`bash
{{checkoutCommands}}
   \`\`\`
2. Read \`PROGRESS.md\` in the repository root if it exists, along with any \`AGENTS.md\` or \`CLAUDE.md\` files in the touched directories, to understand project conventions. Follow them as coding standards, except: do not run the repository's lints, type checks, builds or test suites — CI runs those on the pull request, and step 6 covers how to read them and when a small temporary test is appropriate.
3. write \`/home/node/workspace/progress.json\` before each phase of your work and whenever you move to a new area of the pull request, so the pull request shows what you are doing while you work:
   \`\`\`json
   {"phase": "reading", "step": "Reading the auth middleware and session store"}
   \`\`\`
   \`phase\` is \`"cloning"\`, \`"reading"\`, \`"verifying"\` or \`"writing"\`; \`step\` is one plain sentence (up to 140 characters) naming the files, check or question you are working on right now. Overwrite the file in place; it is optional and must never delay the review.
4. Read the changed files in full (not just the diff hunks) and trace callers, callees, types, and tests around the changes. {{reviewScope}}
5. When \`previous-findings.json\` is attached:
   - Check each previous finding against the code at \`{{headSha}}\`: mark it \`"fixed"\` if the change resolves the problem, \`"open"\` if it still holds, or \`"superseded"\` if the surrounding code was removed or rewritten so the finding no longer applies.
   - If a finding is still \`"open"\`, include it in \`findings\` too (keep its \`id\` and update \`file\`/\`line\` to match \`{{headSha}}\`) so the current findings list remains complete.
   - Check the fixes themselves for regressions or incomplete handling, and look for new issues introduced since the previous review.
6. Check the PR's verification without repeating what CI already runs:
   - Read \`checks.json\` when attached to inspect CI check status, summaries, and failure annotations on \`{{headSha}}\`. Do not re-run lints, type checks, builds or test suites that CI runs on the pull request.
   - Read the tests added or changed in the PR and the existing tests around the touched code to judge what they actually assert and what cases they miss.
   - Run code in \`/home/node/workspace/repo\` only when a small, self-contained smoke test or one-off script that you write temporarily is needed to confirm a specific finding or a claim in the PR description that reading the code and CI results cannot settle. Run it as \`cd /home/node/workspace/repo && <command>\`. If Guardrails blocks a command and offers a remedy plan that needs no person to approve it, apply that plan and retry once; if it requires human approval or still blocks, skip the command and note that in \`limitations\`. Delete any temporary test or script before finishing, and leave \`/home/node/workspace/repo\` clean.
7. Evaluate the changes for:
   - Correctness bugs, edge cases, off-by-one errors, race conditions, null/undefined handling, error propagation.
   - Security issues: authz/authn bypass, injection, SSRF, path traversal, secret leakage, unsafe deserialization, tenant isolation.
   - API, schema, migration, and backward-compatibility hazards.
   - Resource leaks, unbounded work, N+1 queries, missing timeouts or cancellation handling.
   - Missing or weak tests for non-trivial behavior changes.
8. Keep only concrete, defensible findings grounded in the repository code. Skip speculative nitpicks, style preferences already handled by formatters/linters, and issues in unchanged code unless the PR makes them reachable or worse.

## Output contract

Write valid JSON to \`/home/node/workspace/review.json\` matching this exact schema:

\`\`\`json
{
  "title": "Short headline (up to 80 characters) naming the main outcome of the review",
  "summary": "2-4 sentences (at most {{summaryWords}} words) stating what the PR changes and the overall assessment. Do not repeat the finding descriptions or walk through files.",
  "reviewed": [
    "path/or/area — what you checked (e.g. 'src/auth/*.ts — token validation and session refresh')"
  ],
  "changes": [
    {
      "file": "path/relative/to/repo/root.ts (or a directory/glob when grouping related files)",
      "summary": "One short phrase describing what changed in this file or group"
    }
  ],
  "observations": [
    "Worth noting for reviewers, but not a defect requiring a change (e.g. a deliberate trade-off, a follow-up tracked elsewhere, or a subtle interaction that turns out to be safe)"
  ],
  "tests": [
    "What CI ran on {{headSha}} (or what was still running) and any temporary verification you ran, with the result (e.g. 'CI check test: pass; wrote a one-off probe for empty ranges: reproduced the throw')"
  ],
  "coverage": "Assessment of the automated tests added or updated by the PR and any notable gaps",
  "limitations": "Anything you could not verify (e.g. external service, missing credentials, truncated diff), or empty string if none",
  "conclusion": "1-2 sentences on whether the PR is ready to merge and what to address first",
  "previous": [
    {
      "id": "id from previous-findings.json",
      "status": "fixed | open | superseded",
      "note": "One short phrase explaining how it was resolved or why it still holds"
    }
  ],
  "findings": [
    {
      "id": "stable-kebab-case-id",
      "file": "path/relative/to/repo/root.ts",
      "line": 42,
      "end_line": 45,
      "severity": "critical | high | medium | low | nit",
      "title": "Short imperative title",
      "summary": "Clear explanation of the problem and why it matters",
      "failure_scenario": "Concrete input, state, or call sequence that triggers the bug or risk",
      "recommendation": "Concrete fix recommendation",
      "suggestion": "Optional exact replacement code for lines line..end_line (omit if not a simple inline replacement)"
    }
  ]
}
\`\`\`

Field rules:
- \`title\` is a single line of up to 80 characters. When there are blocking findings (\`critical\`, \`high\`, or \`medium\`), name the most important issue; otherwise state briefly that the change is sound (or note the minor follow-ups).
- \`summary\` is 2-4 sentences and at most {{summaryWords}} words. State what the PR changes and the overall judgment; leave file-by-file detail to \`changes\` and issue detail to \`findings\`.
- \`line\` and \`end_line\` are 1-based line numbers in the NEW version of \`file\` at \`{{headSha}}\`.
- If there are no findings, set \`"findings": []\`.
- \`reviewed\`, \`changes\`, \`observations\`, \`tests\`, \`coverage\`, \`limitations\`, and \`conclusion\` should always be populated so a clean PR still gets a substantive review record showing what was inspected and verified. Group related files in \`changes\` when the PR touches many files (keep \`changes\` to at most 20 entries).
- Populate \`previous\` when \`previous-findings.json\` is attached, with one entry per previous finding in the same order; omit \`previous\` (or set \`[]\`) on a first review.
- Do not wrap \`review.json\` in markdown fences.
`;

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function printHelp() {
  console.log(`Usage: node archestra-code-review.mjs [target] [options]

Run the Archestra Code Review on demand for a local branch or pull request checkout
using your single configured Archestra MCP gateway connection and a 100% local-only
repository snapshot transfer (zero GitHub credentials required).

Target (optional):
  <omitted>                        Review current checkout in --repo-dir (default: cwd)
  <pr-number> | #<pr-number>       Review a GitHub PR by number in the current repository
  https://github.com/o/r/pull/N    Review a GitHub PR by URL
  <branch-or-ref>                  Review a local branch or commit ref
  <base>..<head> | <base>...<head> Review an explicit commit range
  /path/to/repo                    Review the current branch in that repository directory

Options:
  -C, --repo-dir <dir>             Local git checkout directory (default: cwd or LOBSTER_ENV_REPOSITORY_DIR)
  --repo <owner/repo>              GitHub repository slug (auto-detected from git remote)
  --pr <number|url>                Explicit PR number or URL
  --base <ref>                     Base branch or commit SHA (auto-detected from PR or default branch)
  --head <ref>                     Head branch or commit SHA (default: HEAD)
  --title <title>                  Override review title when no PR exists
  --body <text>                    Override review description when no PR exists
  --include-uncommitted            Include uncommitted working-tree changes on top of HEAD
  --no-include-uncommitted         Ignore uncommitted working-tree changes
  --local-only                     Transfer local repo snapshot directly without remote git clone (default)
  --public-clone                   Use anonymous git clone + local delta bundle (for public repos only; zero tokens)
  --gateway-url <url>              Archestra MCP gateway URL (auto-discovered from local MCP config / env)
  --token <token>                  Archestra Bearer token (auto-discovered from local MCP config / env)
  --agent-id <uuid>                Specific review runtime agent ID (default: round-robin across the 5 Lobster Code Review subagents)
  --instructions <text>            Additional review instructions
  --instructions-file <path>       Path to additional review instructions markdown file
  --previous-review <path>         Path to previous review JSON (agent-findings.json or review.json)
  --no-previous                    Do not load previous findings from cache or PR sticky comment
  --output-dir <dir>               Directory to write output files (agent-findings.json, chat-report.md, etc.)
  --format <both|markdown|json>    Stdout output format (default: both)
  --keep-workspace                 Do not delete the remote review runtime workspace after completion
  --dry-run                        Prepare all inputs and brief in --output-dir without starting a remote run
  -h, --help                       Show this help message
`);
}

function parseArgs(argv) {
  const opts = {
    target: null,
    repoDir: process.env.LOBSTER_ENV_REPOSITORY_DIR || process.cwd(),
    repo: null,
    pr: null,
    base: null,
    head: null,
    title: null,
    body: null,
    includeUncommitted: null,
    localOnly: true,
    gatewayUrl:
      process.env.ARCHESTRA_REVIEW_GATEWAY_URL ||
      process.env.ARCHESTRA_MCP_GATEWAY_URL ||
      null,
    token:
      process.env.ARCHESTRA_REVIEW_TOKEN ||
      process.env.ARCHESTRA_TOKEN ||
      process.env.ARCHESTRA_API_KEY ||
      null,
    agentId: process.env.ARCHESTRA_REVIEW_AGENT_ID || null,
    instructions: null,
    instructionsFile: null,
    previousReview: null,
    noPrevious: false,
    outputDir: process.env.ARCHESTRA_CODE_REVIEW_OUTPUT_DIR || null,
    format: "both",
    keepWorkspace: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[++i];
    };
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "-C" || arg === "--repo-dir") {
      opts.repoDir = resolve(next());
    } else if (arg === "--repo") {
      opts.repo = next();
    } else if (arg === "--pr") {
      opts.pr = next();
    } else if (arg === "--base") {
      opts.base = next();
    } else if (arg === "--head") {
      opts.head = next();
    } else if (arg === "--title") {
      opts.title = next();
    } else if (arg === "--body") {
      opts.body = next();
    } else if (arg === "--include-uncommitted") {
      opts.includeUncommitted = true;
    } else if (arg === "--no-include-uncommitted") {
      opts.includeUncommitted = false;
    } else if (arg === "--local-only") {
      opts.localOnly = true;
    } else if (arg === "--public-clone") {
      opts.localOnly = false;
    } else if (arg === "--gateway-url") {
      opts.gatewayUrl = next();
    } else if (arg === "--token") {
      opts.token = next();
    } else if (arg === "--agent-id") {
      opts.agentId = next();
    } else if (arg === "--instructions") {
      opts.instructions = next();
    } else if (arg === "--instructions-file") {
      opts.instructionsFile = resolve(next());
    } else if (arg === "--previous-review") {
      opts.previousReview = resolve(next());
    } else if (arg === "--no-previous") {
      opts.noPrevious = true;
    } else if (arg === "--output-dir") {
      opts.outputDir = resolve(next());
    } else if (arg === "--format") {
      const fmt = next().toLowerCase();
      if (!["both", "markdown", "json"].includes(fmt)) {
        throw new Error(`Invalid --format "${fmt}". Expected both, markdown, or json.`);
      }
      opts.format = fmt;
    } else if (arg === "--keep-workspace") {
      opts.keepWorkspace = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!opts.target) {
      opts.target = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  return opts;
}

// ============================================================================
// Shell & Git Helpers
// ============================================================================

function logInfo(msg) {
  process.stderr.write(`[archestra-code-review] ${msg}\n`);
}

function logWarn(msg) {
  process.stderr.write(`[archestra-code-review] WARN: ${msg}\n`);
}

function runCmd(cmd, args, options = {}) {
  try {
    return execFileSync(cmd, args, {
      cwd: options.cwd,
      encoding: options.encoding ?? "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: options.maxBuffer ?? 50 * 1024 * 1024,
      env: options.env ?? process.env,
    });
  } catch (err) {
    if (options.allowFailure) return null;
    const stderr = err.stderr ? String(err.stderr).trim() : err.message;
    throw new Error(`${cmd} ${args.join(" ")} failed: ${stderr}`);
  }
}

function git(repoDir, args, options = {}) {
  const out = runCmd("git", args, { cwd: repoDir, ...options });
  return typeof out === "string" ? out.trimEnd() : out;
}

function ghJson(repoDir, args, options = {}) {
  const out = runCmd("gh", args, { cwd: repoDir, allowFailure: true, ...options });
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function parseRepoSlugFromRemoteUrl(remoteUrl) {
  if (!remoteUrl) return null;
  const cleaned = remoteUrl.trim().replace(/\.git$/, "");
  // https://github.com/owner/repo or org-123@github.com:owner/repo or git@github.com:owner/repo
  const httpsMatch = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(cleaned);
  if (httpsMatch) {
    return {
      serverUrl: `https://${httpsMatch[1]}`,
      owner: httpsMatch[2],
      repo: httpsMatch[3],
      slug: `${httpsMatch[2]}/${httpsMatch[3]}`,
    };
  }
  const sshMatch = /^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/]([^/]+)\/([^/]+)$/.exec(cleaned);
  if (sshMatch) {
    return {
      serverUrl: `https://${sshMatch[1]}`,
      owner: sshMatch[2],
      repo: sshMatch[3],
      slug: `${sshMatch[2]}/${sshMatch[3]}`,
    };
  }
  return null;
}

// ============================================================================
// Archestra Token & Gateway Auto-Discovery
// ============================================================================

function readJsonSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Discovers the caller's single configured Archestra MCP gateway URL and
 * credentials from environment variables and local agent MCP config files
 * without ever logging secret values.
 */
function discoverCredentials(opts) {
  const home = homedir();
  const candidates = [];
  const discoveredGateways = [];
  const discoveredOrigins = [];

  const addGateway = (urlStr) => {
    if (!urlStr || typeof urlStr !== "string") return;
    const cleaned = urlStr.trim().replace(/\/+$/, "");
    if (!cleaned) return;
    try {
      const u = new URL(cleaned);
      if (!discoveredOrigins.includes(u.origin)) discoveredOrigins.push(u.origin);
      if (!discoveredGateways.includes(cleaned)) discoveredGateways.push(cleaned);
    } catch {
      // ignore invalid URL
    }
  };

  const addCandidate = (token, source, gatewayUrl = null) => {
    if (!token || typeof token !== "string") return;
    const cleaned = token.replace(/^Bearer\s+/i, "").trim();
    if (!cleaned) return;
    const normUrl = gatewayUrl ? gatewayUrl.trim().replace(/\/+$/, "") : null;
    if (normUrl) addGateway(normUrl);
    if (candidates.some((c) => c.token === cleaned && c.gatewayUrl === normUrl)) return;
    candidates.push({ token: cleaned, source, gatewayUrl: normUrl });
  };

  if (opts.gatewayUrl) addGateway(opts.gatewayUrl);
  if (process.env.ARCHESTRA_MCP_GATEWAY_URL) addGateway(process.env.ARCHESTRA_MCP_GATEWAY_URL);

  // 1. Explicit CLI flag or high-priority env vars
  if (opts.token) {
    addCandidate(
      opts.token,
      "--token / ARCHESTRA_TOKEN",
      opts.gatewayUrl || process.env.ARCHESTRA_MCP_GATEWAY_URL || null,
    );
  }

  // 2. ~/.gemini/config/mcp_config.json (Antigravity / Gemini single MCP gateway config)
  const geminiMcpConfig = readJsonSafe(join(home, ".gemini/config/mcp_config.json"));
  if (geminiMcpConfig?.mcpServers) {
    for (const [name, srv] of Object.entries(geminiMcpConfig.mcpServers)) {
      const url = srv?.serverUrl || srv?.url;
      if (url) addGateway(url);
      const authHeader = srv?.headers?.Authorization || srv?.headers?.authorization;
      if (authHeader) {
        addCandidate(authHeader, `~/.gemini/config/mcp_config.json (${name})`, url || null);
      }
    }
  }

  // 3. Agent Runtime env var (single MCP gateway injected into the runtime pod)
  if (process.env.ARCHESTRA_MCP_GATEWAY_TOKEN) {
    addCandidate(
      process.env.ARCHESTRA_MCP_GATEWAY_TOKEN,
      "ARCHESTRA_MCP_GATEWAY_TOKEN",
      process.env.ARCHESTRA_MCP_GATEWAY_URL || null,
    );
  }

  // 4. ~/.claude.json
  const claudeJson = readJsonSafe(join(home, ".claude.json"));
  if (claudeJson?.mcpServers) {
    for (const [name, srv] of Object.entries(claudeJson.mcpServers)) {
      const url = srv?.url || srv?.serverUrl;
      if (url && /archestra/i.test(url)) addGateway(url);
      const authHeader = srv?.headers?.Authorization || srv?.headers?.authorization;
      if (authHeader) {
        addCandidate(authHeader, `~/.claude.json (${name})`, url || null);
      }
    }
  }

  // 5. ~/.claude/.credentials.json (mcpOAuth)
  const claudeCreds = readJsonSafe(join(home, ".claude/.credentials.json"));
  if (claudeCreds?.mcpOAuth) {
    for (const [key, entry] of Object.entries(claudeCreds.mcpOAuth)) {
      if (entry?.serverUrl && /archestra/i.test(entry.serverUrl) && entry?.accessToken) {
        addGateway(entry.serverUrl);
        addCandidate(entry.accessToken, `~/.claude/.credentials.json (${key})`, entry.serverUrl);
      }
    }
  }

  // 6. ~/.gemini/antigravity-ide/mcp_oauth_tokens.json
  const agyOauth = readJsonSafe(join(home, ".gemini/antigravity-ide/mcp_oauth_tokens.json"));
  if (agyOauth && typeof agyOauth === "object") {
    for (const [url, entry] of Object.entries(agyOauth)) {
      if (/archestra/i.test(url) && entry?.token) {
        addGateway(url);
        addCandidate(entry.token, `~/.gemini/antigravity-ide/mcp_oauth_tokens.json`, url);
      }
    }
  }

  const origin = discoveredOrigins[0] || "https://frontend.archestra.dev";
  const primaryGatewayUrl = (
    opts.gatewayUrl ||
    discoveredGateways[0] ||
    `${origin}/v1/mcp/code-review`
  ).replace(/\/+$/, "");

  return { primaryGatewayUrl, origin, candidates };
}

/**
 * Persistent round-robin cursor across the 5 Lobster Code Review subagents so
 * consecutive reviews distribute evenly when using a single general MCP gateway.
 */
function nextRoundRobinSubagent(pool, excludedIds = []) {
  const available = pool.filter((id) => !excludedIds.includes(id));
  if (available.length === 0) return null;
  const rrStateFile = join(tmpdir(), "archestra-code-review-rr.json");
  let cursor = 0;
  try {
    const state = readJsonSafe(rrStateFile);
    if (typeof state?.cursor === "number" && Number.isInteger(state.cursor) && state.cursor >= 0) {
      cursor = state.cursor;
    }
  } catch {
    // ignore
  }
  const chosen = available[cursor % available.length];
  try {
    writeFileSync(rrStateFile, JSON.stringify({ cursor: (cursor + 1) % 10_000 }));
  } catch {
    // ignore
  }
  return chosen;
}

// ============================================================================
// Stateless MCP Session & Archestra Client (ported from code-review-action)
// ============================================================================

class ArchestraApiError extends Error {
  constructor(operation, kind, detail, status = null, missingTool = false) {
    const code = status !== null ? ` (HTTP ${status})` : "";
    super(`Archestra ${operation} failed${code}: ${detail}`);
    this.name = "ArchestraApiError";
    this.operation = operation;
    this.kind = kind;
    this.detail = detail;
    this.status = status;
    this.missingTool = missingTool;
  }
}

class McpSession {
  constructor({ url, token, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.requestTimeoutMs = requestTimeoutMs;
    this.protocolVersion = null;
    this.initializing = null;
    this.nextId = 1;
  }

  async listTools(operation) {
    await this.ensureInitialized(operation);
    const result = await this.request("tools/list", {}, operation);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || typeof entry.name !== "string") return [];
      const meta = entry._meta && typeof entry._meta === "object" ? entry._meta : null;
      const targetAgentId = typeof meta?.targetAgentId === "string" ? meta.targetAgentId : null;
      return [{ name: entry.name, targetAgentId }];
    });
  }

  async callTool(name, args, operation) {
    await this.ensureInitialized(operation);
    const result = await this.request("tools/call", { name, arguments: args }, operation);
    if (result?.isError === true) {
      throw new ArchestraApiError(operation, "tool", extractToolErrorText(result));
    }
    if (result?.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent;
    }
    const text = firstContentText(result);
    if (text === null) {
      throw new ArchestraApiError(operation, "response", "tool result had no content");
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON; fall through
    }
    throw new ArchestraApiError(operation, "response", `unexpected tool output: ${text.slice(0, 200)}`);
  }

  async ensureInitialized(operation) {
    if (this.protocolVersion) return;
    this.initializing ??= this.initialize(operation).finally(() => {
      this.initializing = null;
    });
    await this.initializing;
  }

  async initialize(operation) {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "archestra-code-review-skill", version: "1.0.0" },
      },
      operation,
    );
    this.protocolVersion =
      typeof result?.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION;
  }

  async request(method, params, operation) {
    const id = this.nextId++;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.protocolVersion) {
      headers["Mcp-Protocol-Version"] = this.protocolVersion;
    }

    let response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ArchestraApiError(operation, "network", detail);
    }

    const body = await response.text();
    if (!response.ok) {
      throw new ArchestraApiError(
        operation,
        "http",
        extractHttpError(body) || response.statusText || "HTTP error",
        response.status,
      );
    }

    const message = parseRpcBody(body, id, operation, response.headers.get("content-type") ?? "");
    if (message.error) {
      const detail =
        typeof message.error.message === "string" && message.error.message.trim()
          ? message.error.message.trim()
          : "JSON-RPC error";
      const code = typeof message.error.code === "number" ? message.error.code : null;
      throw new ArchestraApiError(operation, "rpc", detail, code);
    }
    return message.result;
  }
}

function parseRpcBody(body, expectedId, operation, contentType) {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new ArchestraApiError(operation, "response", "empty response body");
  }
  if (contentType.includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    let last = null;
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const dataLines = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const msg = parseJsonRpcObject(dataLines.join("\n"), operation);
      if (msg.id === expectedId) return msg;
      if ("result" in msg || "error" in msg) last = msg;
    }
    if (last) return last;
    throw new ArchestraApiError(operation, "response", "event stream held no JSON-RPC response");
  }
  return parseJsonRpcObject(trimmed, operation);
}

function parseJsonRpcObject(text, operation) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ArchestraApiError(operation, "response", `invalid JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ArchestraApiError(operation, "response", "response was not a JSON object");
  }
  return parsed;
}

function firstContentText(result) {
  if (!Array.isArray(result?.content)) return null;
  for (const item of result.content) {
    if (item && typeof item === "object" && typeof item.text === "string") {
      return item.text;
    }
  }
  return null;
}

function extractToolErrorText(result) {
  const text = firstContentText(result);
  if (text?.trim()) return text.trim().replace(/^Error:\s*/i, "");
  return "tool call failed";
}

function extractHttpError(body) {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.error === "string") return parsed.error;
    if (typeof parsed?.error?.message === "string") return parsed.error.message;
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // plain text
  }
  return trimmed.slice(0, 300);
}

const LOBSTER_ENV_CODE_REVIEW_TOOL_NAME = "agent__lobster_env_code_review";

class ArchestraClient {
  constructor({ gatewayUrl, token, fallbackAgentIds = [] }) {
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, "");
    this.origin = new URL(this.gatewayUrl).origin;
    this.session = new McpSession({ url: this.gatewayUrl, token });
    this.toolNames = null;
    this.runTool = null;
    this.advertisedAgentIds = [];
    this.reviewRouterAgentId = null;
    this.fallbackAgentIds = fallbackAgentIds;
    this.runUrls = new Map();
    // Dedicated /v1/mcp/code-review gateways support omitting agent_id directly;
    // on a single general MCP gateway (e.g. My Gateway / staging MCP), we prefer the
    // Lobster Env Code Review router agent (agent__lobster_env_code_review) when present,
    // or fall back to selecting one of the 5 Lobster Code Review subagents.
    this.gatewayAgentSelectionSupported = /\/v1\/mcp\/code-review$/i.test(this.gatewayUrl);
  }

  runUrl(runId) {
    return this.runUrls.get(runId) ?? `${this.origin}/chat/runs/${runId}`;
  }

  async resolveTools(operation) {
    if (!this.toolNames) {
      this.toolNames = this.session.listTools(operation).then(
        (tools) => {
          const names = tools.map((t) => t.name);
          const byShortName = new Map();
          for (const shortName of [...Object.values(RUN_TOOLS), RUN_TOOL]) {
            const match =
              names.find((n) => n === `${ARCHESTRA_PREFIX}${shortName}`) ??
              names.find((n) => n === shortName) ??
              names.find((n) => n.endsWith(`__${shortName}`));
            if (match) byShortName.set(shortName, match);
          }
          this.runTool = byShortName.get(RUN_TOOL) ?? null;
          const advertised = [];
          let routerAgentId = null;
          for (const tool of tools) {
            if (
              tool.name === LOBSTER_ENV_CODE_REVIEW_TOOL_NAME ||
              tool.name.endsWith(`__${LOBSTER_ENV_CODE_REVIEW_TOOL_NAME}`)
            ) {
              routerAgentId = tool.targetAgentId || LOBSTER_ENV_CODE_REVIEW_TOOL_NAME;
            }
            if (tool.targetAgentId && !advertised.includes(tool.targetAgentId)) {
              advertised.push(tool.targetAgentId);
            }
          }
          this.reviewRouterAgentId = routerAgentId;
          this.advertisedAgentIds = advertised;
          return byShortName;
        },
        (err) => {
          this.toolNames = null;
          throw err;
        },
      );
    }
    return this.toolNames;
  }

  selectFallbackAgent(preferredAgentId, excludedIds = []) {
    if (preferredAgentId && !excludedIds.includes(preferredAgentId)) {
      return preferredAgentId;
    }
    if (this.reviewRouterAgentId && !excludedIds.includes(this.reviewRouterAgentId)) {
      return this.reviewRouterAgentId;
    }
    // Prefer the 5 Lobster Code Review subagents unless the gateway explicitly
    // advertises a subset of them.
    const reviewSubagentSet = new Set(this.fallbackAgentIds);
    const matchingAdvertised = this.advertisedAgentIds.filter((id) => reviewSubagentSet.has(id));
    const pool =
      matchingAdvertised.length > 0
        ? matchingAdvertised
        : this.fallbackAgentIds.length > 0
          ? this.fallbackAgentIds
          : this.advertisedAgentIds;
    const candidates = pool.filter((id) => !excludedIds.includes(id));
    return nextRoundRobinSubagent(candidates, excludedIds);
  }

  async call(shortName, args, operation) {
    const names = await this.resolveTools(operation);
    const direct = names.get(shortName);
    if (direct) return this.session.callTool(direct, args, operation);
    if (this.runTool) {
      return this.session.callTool(
        this.runTool,
        { tool_name: `${ARCHESTRA_PREFIX}${shortName}`, tool_args: args },
        operation,
      );
    }
    throw new ArchestraApiError(
      operation,
      "tool",
      `the gateway does not expose ${shortName}.`,
      null,
      true,
    );
  }

  async startRun(agentId, body, excludedIds = []) {
    await this.resolveTools("start run");
    let effectiveAgentId = agentId;
    if (!effectiveAgentId && !this.gatewayAgentSelectionSupported) {
      effectiveAgentId = this.selectFallbackAgent(body.preferredAgentId, excludedIds);
      if (effectiveAgentId) body.onAgentSelected?.(effectiveAgentId);
    }
    const args = {
      ...(effectiveAgentId ? { agent_id: effectiveAgentId } : {}),
      message: body.message,
      ...(body.attachments?.length > 0 ? { attachments: body.attachments } : {}),
    };
    let data;
    try {
      data = await this.call(RUN_TOOLS.start, args, "start run");
    } catch (error) {
      const isToolErr = error instanceof ArchestraApiError && error.kind === "tool";
      const rejectedOmittedAgentId =
        !effectiveAgentId &&
        isToolErr &&
        (/\bagent_id\b.*expected string/i.test(error.detail) ||
          /agent_id is required/i.test(error.detail) ||
          /No runtime subagents are assigned/i.test(error.detail));
      if (rejectedOmittedAgentId) {
        this.gatewayAgentSelectionSupported = false;
        const fallbackAgentId = this.selectFallbackAgent(body.preferredAgentId, excludedIds);
        if (!fallbackAgentId) throw error;
        body.onAgentSelected?.(fallbackAgentId);
        return this.startRun(fallbackAgentId, body, excludedIds);
      }
      // If a specific round-robin subagent failed to launch (e.g. unavailable or rate-limited)
      // and the caller did not pin --agent-id, fail over to the next Lobster Code Review subagent.
      if (effectiveAgentId && !body.preferredAgentId && excludedIds.length < this.fallbackAgentIds.length - 1) {
        const nextExcluded = [...excludedIds, effectiveAgentId];
        const nextAgentId = this.selectFallbackAgent(null, nextExcluded);
        if (nextAgentId) {
          logWarn(
            `Subagent ${AGENT_NAMES_BY_ID.get(effectiveAgentId) ?? effectiveAgentId} failed to launch (${error.message}); failing over to ${AGENT_NAMES_BY_ID.get(nextAgentId) ?? nextAgentId}...`,
          );
          body.onAgentSelected?.(nextAgentId);
          return this.startRun(nextAgentId, body, nextExcluded);
        }
      }
      throw error;
    }
    const run = data?.run;
    if (!run || typeof run.run_id !== "string") {
      throw new ArchestraApiError("start run", "response", "missing run.run_id in response");
    }
    if (typeof data.run_url === "string") {
      this.runUrls.set(run.run_id, data.run_url);
    }
    return {
      runId: run.run_id,
      agentId: run.agent_id ?? effectiveAgentId ?? null,
      agentName:
        run.agent_name ??
        AGENT_NAMES_BY_ID.get(run.agent_id ?? effectiveAgentId ?? "") ??
        null,
      state: run.state,
      runUrl: data.run_url ?? this.runUrl(run.run_id),
      tier: data.limits?.tier ?? null,
    };
  }

  /**
   * Uploads a local file into `/home/node/workspace/<workspacePath>` using
   * `archestra__transfer_workspace_file` (which mints a one-off, short-lived
   * 15-minute, path-and-SHA256-pinned HTTP upload ticket).
   */
  async uploadWorkspaceFile(runId, workspacePath, localPath) {
    const bytes = readFileSync(localPath);
    const size = bytes.byteLength;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const data = await this.call(
      RUN_TOOLS.transfer,
      {
        run_id: runId,
        direction: "upload",
        path: workspacePath,
        local_path: localPath,
        size,
        sha256,
      },
      "authorize workspace file upload",
    );
    const cmd = typeof data?.command === "string" ? data.command : "";
    const urlMatch = /(https?:\/\/[^\s'"]+\/api\/agent-workspace-transfers\/[^\s'"]+\/content)/.exec(cmd);
    const authMatch = /Authorization:\s*(Bearer\s+[^\s'"]+)/i.exec(cmd);
    if (!urlMatch || !authMatch) {
      throw new ArchestraApiError(
        "upload workspace file",
        "response",
        `transfer_workspace_file did not return an upload URL/token: ${cmd.slice(0, 200)}`,
      );
    }
    const uploadUrl = urlMatch[1];
    const authHeader = authMatch[1];
    const resp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: authHeader,
      },
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new ArchestraApiError(
        "upload workspace file",
        "http",
        extractHttpError(errText) || resp.statusText || "upload failed",
        resp.status,
      );
    }
    return { path: workspacePath, size, sha256 };
  }

  async getRun(runId) {
    const data = await this.call(RUN_TOOLS.get, { run_id: runId }, "get run");
    const run = data?.run;
    if (!run || typeof run.state !== "string") {
      throw new ArchestraApiError("get run", "response", "missing run.state in response");
    }
    if (typeof data.run_url === "string") {
      this.runUrls.set(runId, data.run_url);
    }
    const workspace = data.workspace;
    return {
      runId,
      agentId: run.agent_id ?? null,
      agentName: run.agent_name ?? AGENT_NAMES_BY_ID.get(run.agent_id ?? "") ?? null,
      state: run.state,
      statusReason: run.status_reason ?? null,
      failure: run.failure ?? null,
      turnCreatedAt: run.created_at ?? null,
      runUrl: data.run_url ?? this.runUrl(runId),
      tier: data.limits?.tier ?? null,
      workspace: workspace
        ? {
            state: workspace.state,
            retainedUntil: workspace.retained_until ?? null,
            canContinue: Boolean(workspace.can_continue),
            continuationError: workspace.continuation_error ?? null,
          }
        : null,
    };
  }

  async steerRun(runId, message) {
    const data = await this.call(RUN_TOOLS.steer, { run_id: runId, message }, "continue run");
    return data?.status === "steered" ? "steered" : "continued";
  }

  async cancelRun(runId) {
    await this.call(RUN_TOOLS.cancel, { run_id: runId }, "cancel run");
  }

  async deleteWorkspace(runId) {
    await this.call(RUN_TOOLS.delete, { run_id: runId, confirm_delete: true }, "delete workspace");
  }

  async readWorkspaceFile(runId, path) {
    let data;
    try {
      data = await this.call(
        RUN_TOOLS.read,
        { run_id: runId, path, encoding: "base64" },
        "read workspace file",
      );
    } catch (error) {
      if (
        error instanceof ArchestraApiError &&
        error.kind === "tool" &&
        /No such file or directory/i.test(error.detail)
      ) {
        return null;
      }
      throw error;
    }
    if (data?.status === "pending" || typeof data?.content !== "string") {
      throw new ArchestraApiError("read workspace file", "response", `${path} is not readable yet`, 503);
    }
    return Buffer.from(data.content, "base64");
  }
}

/**
 * Connects using the caller's single configured Archestra MCP gateway connection,
 * routing across the 5 Lobster Code Review runtime subagents.
 */
async function connectReviewClient(opts) {
  const { primaryGatewayUrl, candidates } = discoverCredentials(opts);
  if (candidates.length === 0) {
    throw new Error(
      "No Archestra credential found. Sign in to the Archestra MCP server or set ARCHESTRA_TOKEN.",
    );
  }

  const fallbackAgentIds = LOBSTER_CODE_REVIEW_SUBAGENTS.map((a) => a.id);
  const errors = [];

  for (const candidate of candidates) {
    const gatewayUrl = opts.gatewayUrl || candidate.gatewayUrl || primaryGatewayUrl;
    const client = new ArchestraClient({
      gatewayUrl,
      token: candidate.token,
      fallbackAgentIds,
    });
    try {
      await client.resolveTools("connect to Archestra MCP gateway");
      logInfo(`Connected to Archestra MCP gateway (${gatewayUrl}) via ${candidate.source}`);
      return client;
    } catch (err) {
      errors.push(`${candidate.source} @ ${gatewayUrl}: ${err.message}`);
    }
  }

  throw new Error(
    `Could not connect to Archestra MCP gateway:\n  - ${errors.join("\n  - ")}`,
  );
}

// ============================================================================
// Target Resolution (Local Branch, PR Checkout, Commit Range, or Remote PR)
// ============================================================================

function parseTargetSpec(opts) {
  let repoDir = opts.repoDir;
  let prSpec = opts.pr;
  let baseSpec = opts.base;
  let headSpec = opts.head;
  let repoSpec = opts.repo;

  if (opts.target) {
    const t = opts.target.trim();
    // 1. Directory path on disk?
    if (existsSync(t) && (() => { try { return readFileSync(t) && false; } catch { return true; } })()) {
      repoDir = resolve(t);
    } else if (/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.test(t)) {
      const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(t);
      repoSpec ??= `${m[1]}/${m[2]}`;
      prSpec ??= Number(m[3]);
    } else if (/^#?\d+$/.test(t)) {
      prSpec ??= Number(t.replace(/^#/, ""));
    } else if (t.includes("...")) {
      const [b, h] = t.split("...");
      baseSpec ??= b || null;
      headSpec ??= h || "HEAD";
    } else if (t.includes("..")) {
      const [b, h] = t.split("..");
      baseSpec ??= b || null;
      headSpec ??= h || "HEAD";
    } else {
      headSpec ??= t;
    }
  }

  return { repoDir, prSpec, baseSpec, headSpec, repoSpec };
}

function resolveGitTarget(opts) {
  const { repoDir, prSpec, baseSpec, headSpec, repoSpec } = parseTargetSpec(opts);

  // Verify repoDir is inside a git repository
  const topLevel = git(repoDir, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!topLevel) {
    throw new Error(`Directory ${repoDir} is not a git repository checkout.`);
  }
  const effectiveRepoDir = topLevel.trim();

  // Resolve repository owner/repo and serverUrl
  const originUrl = git(effectiveRepoDir, ["remote", "get-url", "origin"], { allowFailure: true });
  const parsedOrigin = parseRepoSlugFromRemoteUrl(originUrl);
  const serverUrl = parsedOrigin?.serverUrl || "https://github.com";
  const repository = repoSpec || parsedOrigin?.slug;
  if (!repository || !repository.includes("/")) {
    throw new Error(
      `Could not determine GitHub owner/repo from git remote in ${effectiveRepoDir}. Pass --repo <owner/repo>.`,
    );
  }
  const [owner, repo] = repository.split("/");

  // Try to discover matching PR metadata via gh if available
  let prMeta = null;
  if (prSpec) {
    prMeta = ghJson(effectiveRepoDir, [
      "pr",
      "view",
      String(prSpec),
      "--repo",
      repository,
      "--json",
      "number,title,body,url,author,baseRefName,baseRefOid,headRefName,headRefOid",
    ]);
  } else if (!baseSpec && (!headSpec || headSpec === "HEAD")) {
    // Check if current branch has an open PR
    prMeta = ghJson(effectiveRepoDir, [
      "pr",
      "view",
      "--json",
      "number,title,body,url,author,baseRefName,baseRefOid,headRefName,headRefOid",
    ]);
  }

  // Determine head ref and head SHA
  const resolvedHeadRef =
    headSpec ||
    git(effectiveRepoDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }) ||
    prMeta?.headRefName ||
    "HEAD";

  let headSha = git(effectiveRepoDir, ["rev-parse", "--verify", `${headSpec || "HEAD"}^{commit}`], {
    allowFailure: true,
  });

  // If the user asked for a PR number whose head commit is not fetched locally yet, fetch it
  if ((!headSha || (prSpec && prMeta?.headRefOid && headSha !== prMeta.headRefOid && !headSpec)) && prMeta?.headRefOid) {
    const hasPrCommitLocally = git(
      effectiveRepoDir,
      ["cat-file", "-e", `${prMeta.headRefOid}^{commit}`],
      { allowFailure: true },
    );
    if (hasPrCommitLocally === null) {
      logInfo(`Fetching PR #${prMeta.number} head (${prMeta.headRefOid.slice(0, 7)}) from origin...`);
      git(effectiveRepoDir, ["fetch", "--no-tags", "origin", `pull/${prMeta.number}/head`], {
        allowFailure: true,
      });
    }
    if (prSpec && !headSpec) {
      const verifiedPrHead = git(
        effectiveRepoDir,
        ["rev-parse", "--verify", `${prMeta.headRefOid}^{commit}`],
        { allowFailure: true },
      );
      if (verifiedPrHead) headSha = verifiedPrHead;
    }
  }

  if (!headSha) {
    throw new Error(`Could not resolve head commit for "${headSpec || "HEAD"}" in ${effectiveRepoDir}.`);
  }

  // Determine base ref and base SHA
  let baseRef = baseSpec || prMeta?.baseRefName || null;
  if (!baseRef) {
    const originHead = git(effectiveRepoDir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {
      allowFailure: true,
    });
    if (originHead) {
      baseRef = originHead.replace(/^refs\/remotes\/origin\//, "");
    } else {
      const repoView = ghJson(effectiveRepoDir, [
        "repo",
        "view",
        repository,
        "--json",
        "defaultBranchRef",
      ]);
      baseRef = repoView?.defaultBranchRef?.name || "main";
    }
  }

  // Resolve merge-base between baseRef (or origin/baseRef) and headSha
  let baseCandidate = baseRef;
  if (
    git(effectiveRepoDir, ["rev-parse", "--verify", `refs/remotes/origin/${baseRef}^{commit}`], {
      allowFailure: true,
    })
  ) {
    baseCandidate = `refs/remotes/origin/${baseRef}`;
  } else if (
    !git(effectiveRepoDir, ["rev-parse", "--verify", `${baseRef}^{commit}`], { allowFailure: true }) &&
    prMeta?.baseRefOid
  ) {
    git(effectiveRepoDir, ["fetch", "--no-tags", "origin", baseRef], { allowFailure: true });
    baseCandidate =
      git(effectiveRepoDir, ["rev-parse", "--verify", `refs/remotes/origin/${baseRef}^{commit}`], {
        allowFailure: true,
      }) || prMeta.baseRefOid;
  }

  const mergeBase = git(effectiveRepoDir, ["merge-base", baseCandidate, headSha], {
    allowFailure: true,
  });
  const baseSha =
    mergeBase ||
    git(effectiveRepoDir, ["rev-parse", "--verify", `${baseCandidate}^{commit}`], {
      allowFailure: true,
    }) ||
    prMeta?.baseRefOid;

  if (!baseSha) {
    throw new Error(`Could not resolve base commit for "${baseRef}" in ${effectiveRepoDir}.`);
  }

  // Check for uncommitted tracked changes when reviewing current HEAD
  const isCurrentHead =
    headSha === git(effectiveRepoDir, ["rev-parse", "HEAD"], { allowFailure: true });
  const workingTreeDiff = isCurrentHead
    ? git(effectiveRepoDir, ["diff", "--no-color", "--full-index", "HEAD"], { allowFailure: true }) || ""
    : "";
  const hasUncommitted = workingTreeDiff.trim().length > 0;
  const includeUncommitted =
    opts.includeUncommitted === true ||
    (opts.includeUncommitted === null && headSha === baseSha && hasUncommitted);

  // Compute changed files and unified diff
  const diffArgs = includeUncommitted
    ? ["diff", "--no-color", "--full-index", "--find-renames", baseSha]
    : ["diff", "--no-color", "--full-index", "--find-renames", `${baseSha}..${headSha}`];
  const rawDiff = git(effectiveRepoDir, diffArgs);

  const nameStatusArgs = includeUncommitted
    ? ["diff", "--name-status", "--find-renames", baseSha]
    : ["diff", "--name-status", "--find-renames", `${baseSha}..${headSha}`];
  const numstatArgs = includeUncommitted
    ? ["diff", "--numstat", "--find-renames", baseSha]
    : ["diff", "--numstat", "--find-renames", `${baseSha}..${headSha}`];

  const nameStatusOut = git(effectiveRepoDir, nameStatusArgs);
  const numstatOut = git(effectiveRepoDir, numstatArgs);

  const changedFiles = parseGitChangedFiles(nameStatusOut, numstatOut, rawDiff);

  // Check if headSha exists on origin
  let headOnRemote = false;
  if (prMeta?.headRefOid === headSha) {
    headOnRemote = true;
  } else {
    const remoteBranches = git(effectiveRepoDir, ["branch", "-r", "--contains", headSha], {
      allowFailure: true,
    });
    if (remoteBranches && remoteBranches.trim().length > 0) {
      headOnRemote = true;
    } else {
      const commitCheck = runCmd(
        "gh",
        ["api", `repos/${repository}/commits/${headSha}`, "--jq", ".sha"],
        { cwd: effectiveRepoDir, allowFailure: true },
      );
      if (commitCheck && commitCheck.trim() === headSha) {
        headOnRemote = true;
      }
    }
  }

  // Synthesize title, body, author, number, url when no PR exists
  const prNumber = prMeta?.number ?? 0;
  const prUrl =
    prMeta?.url ??
    (prNumber > 0
      ? `${serverUrl}/${repository}/pull/${prNumber}`
      : `${serverUrl}/${repository}/compare/${baseRef}...${resolvedHeadRef}`);
  const title =
    opts.title ||
    prMeta?.title ||
    git(effectiveRepoDir, ["log", "-1", "--format=%s", headSha], { allowFailure: true }) ||
    `Changes on ${resolvedHeadRef}`;
  const body =
    opts.body ??
    prMeta?.body ??
    (git(effectiveRepoDir, ["log", "--reverse", "--format=- %s (%h)%n%w(0,2,2)%b", `${baseSha}..${headSha}`], {
      allowFailure: true,
    }) || "");
  const author =
    prMeta?.author?.login ||
    git(effectiveRepoDir, ["log", "-1", "--format=%an", headSha], { allowFailure: true }) ||
    "local";

  return {
    repoDir: effectiveRepoDir,
    serverUrl,
    owner,
    repo,
    repository,
    cloneUrl: `${serverUrl}/${repository}.git`,
    repoUrl: `${serverUrl}/${repository}`,
    number: prNumber,
    url: prUrl,
    title: briefTitle(title),
    body: String(body ?? "").slice(0, 20_000),
    author,
    baseRef: baseRef.replace(/^refs\/remotes\/origin\//, ""),
    baseSha,
    headRef: resolvedHeadRef,
    headSha,
    headOnRemote,
    includeUncommitted,
    uncommittedPatch: includeUncommitted ? workingTreeDiff : null,
    rawDiff,
    changedFiles,
  };
}

function briefTitle(title) {
  const line = String(title).replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function parseGitChangedFiles(nameStatusOut, numstatOut, fullDiff) {
  const statsByPath = new Map();
  for (const line of numstatOut.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const deletions = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    const pathPart = parts.slice(2).join("\t");
    // Handle rename syntax in numstat if any
    const finalPath = pathPart.includes("=>")
      ? normalizeRenamePath(pathPart)
      : pathPart;
    statsByPath.set(finalPath, { additions, deletions });
  }

  const patchesByPath = splitUnifiedDiffByFile(fullDiff);
  const files = [];

  for (const line of nameStatusOut.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0][0];
    let status = "modified";
    let filename = parts[1];
    let previousFilename;
    if (code === "A") status = "added";
    else if (code === "D") status = "removed";
    else if (code === "R") {
      status = "renamed";
      previousFilename = parts[1];
      filename = parts[2];
    } else if (code === "C") {
      status = "copied";
      previousFilename = parts[1];
      filename = parts[2];
    }
    const stat = statsByPath.get(filename) ?? { additions: 0, deletions: 0 };
    files.push({
      filename,
      status,
      additions: stat.additions,
      deletions: stat.deletions,
      changes: stat.additions + stat.deletions,
      ...(previousFilename ? { previousFilename } : {}),
      patch: patchesByPath.get(filename),
    });
  }
  return files;
}

function normalizeRenamePath(raw) {
  // e.g. "src/{old.ts => new.ts}" or "old.ts => new.ts"
  const braceMatch = /^(.*)\{([^{}]*)\s=>\s([^{}]*)\}(.*)$/.exec(raw);
  if (braceMatch) {
    return `${braceMatch[1]}${braceMatch[3]}${braceMatch[4]}`.replace(/\/\//g, "/");
  }
  const arrowParts = raw.split(/\s=>\s/);
  return arrowParts[arrowParts.length - 1];
}

function splitUnifiedDiffByFile(fullDiff) {
  const map = new Map();
  if (!fullDiff) return map;
  const chunks = fullDiff.split(/^diff --git /m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const plusLine = /^\+\+\+ b\/(.+)$/m.exec(chunk);
    const minusLine = /^--- a\/(.+)$/m.exec(chunk);
    const headerMatch = /^a\/(.+?) b\/(.+)$/m.exec(chunk);
    const filePath = plusLine?.[1] || headerMatch?.[2] || minusLine?.[1];
    if (!filePath) continue;
    const hunkStart = chunk.indexOf("\n@@ ");
    if (hunkStart !== -1) {
      map.set(filePath, chunk.slice(hunkStart + 1));
    }
  }
  return map;
}

// ============================================================================
// Local Snapshot Archive & CI Check Snapshot Helpers (Zero GitHub Credentials)
// ============================================================================

const HEAVY_STATIC_EXCLUDES = [
  "*.mp4",
  "*.mov",
  "*.webm",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.ico",
  "*.woff2",
  "*.ttf",
  "*.pdf",
  "docs/openapi.json",
  "platform/backend/src/database/migrations/meta/*_snapshot.json",
];

/**
 * Packages the local git tree at `target.headSha` into `repo-head.tar.gz` inside
 * `outputDir` without touching any remote server or GitHub token.
 */
function createLocalRepoArchive(target, outputDir) {
  const archivePath = join(outputDir, "repo-head.tar.gz");
  const changedPaths = target.changedFiles.map((f) => f.filename);
  const pathspecs = ["."];
  for (const pattern of HEAVY_STATIC_EXCLUDES) {
    const suffix = pattern.startsWith("*.") ? pattern.slice(1) : null;
    const touched = changedPaths.some((p) =>
      suffix ? p.endsWith(suffix) : p === pattern || p.startsWith(pattern.replace(/\*.*$/, "")),
    );
    if (!touched) {
      pathspecs.push(`:(exclude)${pattern}`);
    }
  }
  try {
    git(target.repoDir, [
      "archive",
      "--format=tar.gz",
      `-o`,
      archivePath,
      target.headSha,
      "--",
      ...pathspecs,
    ]);
  } catch {
    // Fallback to plain git archive without pathspec excludes if git version rejects any pathspec
    git(target.repoDir, ["archive", "--format=tar.gz", "-o", archivePath, target.headSha]);
  }
  const size = readFileSync(archivePath).byteLength;
  return { archivePath, size };
}

/**
 * Fetches the GitHub Actions check runs on `headSha` when the commit is on GitHub,
 * matching `fetchCheckSnapshot` in `code-review-action/src/github/ci.ts`.
 */
function fetchCheckSnapshot(target) {
  if (!target.headOnRemote) return [];
  const raw = runCmd(
    "gh",
    [
      "api",
      `repos/${target.repository}/commits/${target.headSha}/check-runs?per_page=100`,
      "--paginate",
      "--jq",
      ".check_runs[] | {id: .id, name: .name, status: .status, conclusion: .conclusion, html_url: .html_url, details_url: .details_url, output: {title: .output.title, summary: .output.summary, annotations_count: .output.annotations_count}}",
    ],
    { cwd: target.repoDir, allowFailure: true },
  );
  if (!raw) return [];
  const runs = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      runs.push(JSON.parse(line));
    } catch {
      // ignore malformed line
    }
  }

  return runs.slice(0, 100).map((r) => {
    const summaryText = [r.output?.title, r.output?.summary].filter(Boolean).join(" — ").trim();
    const isFailed =
      r.conclusion === "failure" ||
      r.conclusion === "timed_out" ||
      r.conclusion === "startup_failure" ||
      r.conclusion === "action_required";
    let annotations;
    if (isFailed && (r.output?.annotations_count ?? 0) > 0 && r.id) {
      const annRaw = runCmd(
        "gh",
        ["api", `repos/${target.repository}/check-runs/${r.id}/annotations?per_page=20`],
        { cwd: target.repoDir, allowFailure: true },
      );
      if (annRaw) {
        try {
          const parsedAnn = JSON.parse(annRaw);
          if (Array.isArray(parsedAnn) && parsedAnn.length > 0) {
            annotations = parsedAnn.slice(0, 20).map((a) => ({
              path: a.path ?? "",
              line: a.start_line ?? 1,
              level: a.annotation_level ?? "failure",
              message: String(a.message ?? "").slice(0, 400),
            }));
          }
        } catch {
          // ignore
        }
      }
    }
    return {
      name: r.name,
      status: r.status,
      conclusion: r.conclusion ?? null,
      url: r.html_url ?? r.details_url ?? null,
      ...(summaryText ? { summary: summaryText.slice(0, 2000) } : {}),
      ...(annotations ? { annotations } : {}),
    };
  });
}

// ============================================================================
// Previous Findings Discovery (Local Cache or PR Sticky Comment)
// ============================================================================

const STICKY_STATE_PATTERN = /<!-- archestra-state:([A-Za-z0-9_-]+) -->/g;

function branchCacheSlug(ref) {
  return String(ref || "HEAD").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function defaultPreviousCachePath(target) {
  const gitDir = git(target.repoDir, ["rev-parse", "--git-common-dir"], { allowFailure: true });
  if (!gitDir) return null;
  const resolvedGitDir = isAbsolute(gitDir) ? gitDir : resolve(target.repoDir, gitDir);
  return join(
    resolvedGitDir,
    "archestra-code-review",
    `last-review-${branchCacheSlug(target.headRef)}.json`,
  );
}

function loadPreviousFindings(target, opts) {
  if (opts.noPrevious) return [];

  // 1. Explicit --previous-review file
  if (opts.previousReview && existsSync(opts.previousReview)) {
    const data = readJsonSafe(opts.previousReview);
    const findings = extractFindingsList(data);
    if (findings.length > 0) {
      logInfo(`Loaded ${findings.length} previous finding(s) from ${opts.previousReview}`);
      return findings;
    }
  }

  // 2. Local git branch cache from earlier on-demand review
  const cachePath = defaultPreviousCachePath(target);
  if (cachePath && existsSync(cachePath)) {
    const data = readJsonSafe(cachePath);
    const findings = extractFindingsList(data);
    if (findings.length > 0) {
      logInfo(`Loaded ${findings.length} previous finding(s) from local branch cache (${cachePath})`);
      return findings;
    }
  }

  // 3. Existing Archestra sticky comment on the GitHub PR (if PR exists)
  if (target.number > 0) {
    const commentsRaw = runCmd(
      "gh",
      [
        "api",
        `repos/${target.repository}/issues/${target.number}/comments?per_page=100`,
        "--jq",
        ".[].body",
      ],
      { cwd: target.repoDir, allowFailure: true },
    );
    if (commentsRaw) {
      const matches = [...commentsRaw.matchAll(STICKY_STATE_PATTERN)];
      const lastMatch = matches.at(-1);
      if (lastMatch?.[1]) {
        try {
          const decoded = JSON.parse(Buffer.from(lastMatch[1], "base64url").toString("utf8"));
          const findings = extractFindingsList(decoded);
          if (findings.length > 0) {
            logInfo(`Loaded ${findings.length} previous finding(s) from PR #${target.number} sticky comment`);
            return findings;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return [];
}

function extractFindingsList(data) {
  if (!data || typeof data !== "object") return [];
  const rawList = Array.isArray(data.findings)
    ? data.findings
    : Array.isArray(data.review?.findings)
      ? data.review.findings
      : [];
  return rawList
    .filter((f) => f && typeof f === "object" && typeof f.id === "string" && typeof f.file === "string")
    .map((f) => ({
      id: f.id,
      file: f.file,
      line: Number(f.line) || 1,
      ...(f.end_line ? { end_line: Number(f.end_line) } : {}),
      severity: f.severity || "medium",
      title: f.title || "",
      summary: f.summary || "",
      ...(f.failure_scenario ? { failure_scenario: f.failure_scenario } : {}),
      recommendation: f.recommendation || "",
      status: f.status || "open",
    }));
}

// ============================================================================
// Brief & Attachments Construction (matching code-review-action/src/modes/review.ts)
// ============================================================================

function summaryWordCap(changedLines) {
  if (changedLines <= 50) return 60;
  if (changedLines <= 400) return 120;
  if (changedLines <= 2000) return 200;
  return 300;
}

function reviewScopeNote({ diffTruncated, previousCount }) {
  if (previousCount > 0) {
    const noun = previousCount === 1 ? "1 finding" : `${previousCount} findings`;
    const base = `\`previous-findings.json\` lists ${noun} from the earlier review of this pull request. Verify each one against \`{{headSha}}\` first, then review the changes and fixes for new issues.`;
    return diffTruncated
      ? `${base} \`pr.diff\` was truncated at 5 MiB; inspect every file in \`changedFiles\` directly in \`/home/node/workspace/repo\`.`
      : base;
  }
  if (diffTruncated) {
    return "`pr.diff` was truncated at 5 MiB. Do not rely on `pr.diff` alone: inspect every file listed in `changedFiles` in `pr.json` (and `git diff` in `/home/node/workspace/repo`) so files beyond the truncation point are still reviewed.";
  }
  return "`pr.diff` is complete; read the touched files in `/home/node/workspace/repo` for surrounding context, and you do not need to re-run `git diff` to discover what changed.";
}

function buildAttachmentsAndBrief(target, opts, checks, previousFindings, outputDir) {
  const diffBuf = Buffer.from(target.rawDiff, "utf8");
  const diffTruncated = diffBuf.byteLength > MAX_DIFF_BYTES;
  const boundedDiffBuf = diffTruncated ? diffBuf.subarray(0, MAX_DIFF_BYTES) : diffBuf;

  const prJson = {
    repository: target.repository,
    number: target.number,
    url: target.url,
    title: target.title,
    body: target.body,
    author: target.author,
    base: { ref: target.baseRef, sha: target.baseSha },
    head: { ref: target.headRef, sha: target.headSha },
    diffTruncated,
    changedFiles: target.changedFiles.map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      ...(f.previousFilename ? { previousPath: f.previousFilename } : {}),
    })),
  };

  const attachments = [
    {
      name: "pr.json",
      contentType: "application/json",
      contentBase64: Buffer.from(JSON.stringify(prJson, null, 2), "utf8").toString("base64"),
    },
    {
      name: "pr.diff",
      contentType: "text/x-diff",
      contentBase64: boundedDiffBuf.toString("base64"),
    },
  ];

  let deliveryMode = "local-inline-archive";
  let stagedArchivePath = null;
  let hasLocalBundle = false;

  if (opts.localOnly) {
    // 100% local-only workflow: package the local git tree at headSha directly from disk
    // without touching any remote GitHub credentials.
    const { archivePath, size } = createLocalRepoArchive(target, outputDir);
    if (size <= MAX_INLINE_ARCHIVE_BYTES) {
      attachments.push({
        name: "repo-head.tar.gz",
        contentType: "application/gzip",
        contentBase64: readFileSync(archivePath).toString("base64"),
      });
      deliveryMode = "local-inline-archive";
    } else {
      stagedArchivePath = archivePath;
      deliveryMode = "local-transfer-ticket";
    }
  } else if (!target.headOnRemote && target.headSha !== target.baseSha) {
    const tmpBundleDir = mkdtempSync(join(tmpdir(), "archestra-review-bundle-"));
    const bundlePath = join(tmpBundleDir, "head.bundle");
    try {
      git(target.repoDir, ["bundle", "create", bundlePath, `${target.baseSha}..${target.headSha}`]);
      const bundleBytes = readFileSync(bundlePath);
      attachments.push({
        name: "head.bundle",
        contentType: "application/octet-stream",
        contentBase64: bundleBytes.toString("base64"),
      });
      hasLocalBundle = true;
    } finally {
      rmSync(tmpBundleDir, { recursive: true, force: true });
    }
    deliveryMode = "public-clone-local-bundle";
  } else {
    deliveryMode = "public-clone";
  }

  let hasUncommittedPatch = false;
  if (target.includeUncommitted && target.uncommittedPatch?.trim()) {
    attachments.push({
      name: "uncommitted.patch",
      contentType: "text/x-diff",
      contentBase64: Buffer.from(target.uncommittedPatch, "utf8").toString("base64"),
    });
    hasUncommittedPatch = true;
  }

  // Optional instructions.md
  const instructionParts = [];
  if (opts.instructions?.trim()) instructionParts.push(opts.instructions.trim());
  if (opts.instructionsFile && existsSync(opts.instructionsFile)) {
    instructionParts.push(readFileSync(opts.instructionsFile, "utf8").trim());
  }
  if (instructionParts.length > 0) {
    attachments.push({
      name: "instructions.md",
      contentType: "text/markdown",
      contentBase64: Buffer.from(instructionParts.join("\n\n"), "utf8").toString("base64"),
    });
  }

  if (checks.length > 0) {
    attachments.push({
      name: "checks.json",
      contentType: "application/json",
      contentBase64: Buffer.from(JSON.stringify(checks, null, 2), "utf8").toString("base64"),
    });
  }

  if (previousFindings.length > 0) {
    attachments.push({
      name: "previous-findings.json",
      contentType: "application/json",
      contentBase64: Buffer.from(JSON.stringify(previousFindings, null, 2), "utf8").toString("base64"),
    });
  }

  const changedLines = target.changedFiles.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const summaryWords = String(summaryWordCap(changedLines));
  const rawScope = reviewScopeNote({ diffTruncated, previousCount: previousFindings.length });
  const reviewScope = rawScope.replaceAll("{{headSha}}", target.headSha);

  // Build checkout/materialization commands for step 1 of the brief
  const checkoutLines = [];
  if (opts.localOnly) {
    checkoutLines.push(
      `   mkdir -p /home/node/workspace/repo`,
      `   ARCHIVE_PATH="/home/node/workspace/repo-head.tar.gz"`,
      `   if [ ! -f "$ARCHIVE_PATH" ]; then`,
      `     ARCHIVE_PATH="$(find "\${ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_DIR:-/home/node}" -name "*repo-head.tar.gz" 2>/dev/null | head -n 1)"`,
      `   fi`,
      `   tar -xzf "$ARCHIVE_PATH" -C /home/node/workspace/repo`,
      `   cd /home/node/workspace/repo`,
      `   git init -q && git config user.email "review@archestra.local" && git config user.name "Archestra Review" && git add -A && git commit -qm "snapshot ${target.headSha}"`,
    );
  } else {
    checkoutLines.push(
      `   git clone --filter=blob:none --no-checkout ${target.cloneUrl} /home/node/workspace/repo`,
      `   cd /home/node/workspace/repo`,
    );
    if (hasLocalBundle) {
      checkoutLines.push(
        `   git fetch --depth=1 origin ${target.baseSha}`,
        `   BUNDLE_PATH="$(find "\${ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_DIR:-/home/node}" -name "*head.bundle" 2>/dev/null | head -n 1)"`,
        `   git bundle unbundle "$BUNDLE_PATH" || git fetch "$BUNDLE_PATH" ${target.headSha}`,
        `   git checkout --detach ${target.headSha}`,
      );
    } else {
      checkoutLines.push(
        `   git fetch --depth=1 origin ${target.baseSha} ${target.headSha}`,
        `   git checkout --detach ${target.headSha}`,
      );
    }
  }
  if (hasUncommittedPatch) {
    checkoutLines.push(
      `   PATCH_PATH="$(find "\${ARCHESTRA_AGENT_RUNTIME_ATTACHMENTS_DIR:-/home/node}" -name "*uncommitted.patch" 2>/dev/null | head -n 1)"`,
      `   git apply --index "$PATCH_PATH"`,
    );
  }

  const prLabel = target.number > 0 ? `#${target.number}` : `branch ${target.headRef}`;

  const brief = REVIEW_BRIEF_TEMPLATE.replaceAll("{{prLabel}}", prLabel)
    .replaceAll("{{repo}}", target.repository)
    .replaceAll("{{number}}", String(target.number))
    .replaceAll("{{title}}", target.title)
    .replaceAll("{{cloneUrl}}", target.cloneUrl)
    .replaceAll("{{headSha}}", target.headSha)
    .replaceAll("{{baseSha}}", target.baseSha)
    .replaceAll("{{summaryWords}}", summaryWords)
    .replaceAll("{{reviewScope}}", reviewScope)
    .replaceAll("{{checkoutCommands}}", checkoutLines.join("\n"));

  return {
    prJson,
    boundedDiffBuf,
    diffTruncated,
    attachments,
    brief,
    deliveryMode,
    stagedArchivePath,
  };
}

// ============================================================================
// Contract Validation & Null Stripping (ported from code-review-action/src/contracts.ts)
// ============================================================================

function withoutNullValues(value) {
  if (Array.isArray(value)) return value.map(withoutNullValues);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== null) out[k] = withoutNullValues(v);
    }
    return out;
  }
  return value;
}

function validateReviewResult(raw) {
  const cleaned = withoutNullValues(raw);
  if (!cleaned || typeof cleaned !== "object" || Array.isArray(cleaned)) {
    throw new Error("review.json must be a JSON object");
  }
  if (typeof cleaned.summary !== "string" || !cleaned.summary.trim()) {
    throw new Error("review.json: summary must be a non-empty string");
  }
  if (!Array.isArray(cleaned.findings)) {
    throw new Error("review.json: findings must be an array");
  }
  const findings = cleaned.findings.map((f, idx) => {
    if (!f || typeof f !== "object") throw new Error(`findings[${idx}] must be an object`);
    if (typeof f.id !== "string" || !f.id.trim()) throw new Error(`findings[${idx}].id is required`);
    if (typeof f.file !== "string" || !f.file.trim()) throw new Error(`findings[${idx}].file is required`);
    const line = Number(f.line);
    if (!Number.isInteger(line) || line <= 0) {
      throw new Error(`findings[${idx}].line must be a positive integer`);
    }
    const endLine = f.end_line !== undefined ? Number(f.end_line) : undefined;
    if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < line)) {
      throw new Error(`findings[${idx}].end_line must be an integer >= line`);
    }
    const severity = String(f.severity || "").toLowerCase();
    if (!SEVERITIES.includes(severity)) {
      throw new Error(`findings[${idx}].severity must be one of ${SEVERITIES.join(", ")}`);
    }
    if (typeof f.title !== "string" || !f.title.trim()) {
      throw new Error(`findings[${idx}].title is required`);
    }
    if (typeof f.summary !== "string" || !f.summary.trim()) {
      throw new Error(`findings[${idx}].summary is required`);
    }
    if (typeof f.recommendation !== "string" || !f.recommendation.trim()) {
      throw new Error(`findings[${idx}].recommendation is required`);
    }
    return {
      id: f.id.trim().slice(0, 120),
      file: f.file.trim().slice(0, 1000),
      line,
      ...(endLine !== undefined ? { end_line: endLine } : {}),
      severity,
      title: f.title.trim().slice(0, 200),
      summary: f.summary.trim().slice(0, 4000),
      ...(typeof f.failure_scenario === "string" && f.failure_scenario.trim()
        ? { failure_scenario: f.failure_scenario.trim().slice(0, 2000) }
        : {}),
      recommendation: f.recommendation.trim().slice(0, 4000),
      ...(typeof f.suggestion === "string" && f.suggestion.length > 0
        ? { suggestion: f.suggestion.slice(0, 8000) }
        : {}),
    };
  });

  const changes = Array.isArray(cleaned.changes)
    ? cleaned.changes
        .filter((c) => c && typeof c.file === "string" && typeof c.summary === "string")
        .slice(0, 30)
        .map((c) => ({ file: c.file.trim().slice(0, 1000), summary: c.summary.trim().slice(0, 300) }))
    : [];

  const previous = Array.isArray(cleaned.previous)
    ? cleaned.previous
        .filter(
          (p) =>
            p &&
            typeof p.id === "string" &&
            ["fixed", "open", "superseded"].includes(p.status),
        )
        .slice(0, 200)
        .map((p) => ({
          id: p.id.trim().slice(0, 120),
          status: p.status,
          ...(typeof p.note === "string" ? { note: p.note.trim().slice(0, 400) } : {}),
        }))
    : [];

  const stringList = (arr, maxItems, maxChars) =>
    Array.isArray(arr)
      ? arr
          .filter((s) => typeof s === "string" && s.trim())
          .slice(0, maxItems)
          .map((s) => s.trim().slice(0, maxChars))
      : [];

  return {
    ...(typeof cleaned.title === "string" && cleaned.title.trim()
      ? { title: cleaned.title.trim().slice(0, 200) }
      : {}),
    summary: cleaned.summary.trim().slice(0, 8000),
    reviewed: stringList(cleaned.reviewed, 40, 500),
    changes,
    observations: stringList(cleaned.observations, 20, 1000),
    tests: stringList(cleaned.tests, 30, 500),
    coverage: typeof cleaned.coverage === "string" ? cleaned.coverage.trim().slice(0, 4000) : "",
    limitations:
      typeof cleaned.limitations === "string" ? cleaned.limitations.trim().slice(0, 4000) : "",
    conclusion:
      typeof cleaned.conclusion === "string" ? cleaned.conclusion.trim().slice(0, 2000) : "",
    previous,
    findings,
  };
}

// ============================================================================
// Run Execution, Progress Polling, Contract Read & Cleanup
// ============================================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readContract(client, runId, filePath) {
  const raw = await client.readWorkspaceFile(runId, filePath);
  if (raw === null) return { ok: false, reason: `${filePath} was not written` };
  let json;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    return {
      ok: false,
      reason: `${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    return { ok: true, data: validateReviewResult(json) };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function pollUntilTerminal(client, started) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let interval = INITIAL_POLL_MS;
  let pollErrors = 0;
  let lastProgressKey = "";

  while (Date.now() < deadline) {
    await sleep(interval);
    interval = Math.min(MAX_POLL_MS, Math.round(interval * POLL_BACKOFF));

    let run;
    try {
      run = await client.getRun(started.runId);
      pollErrors = 0;
    } catch (err) {
      pollErrors++;
      logWarn(
        `Poll error on run ${started.runId} (${pollErrors}/${MAX_CONSECUTIVE_POLL_ERRORS}): ${err.message}`,
      );
      if (pollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) throw err;
      continue;
    }

    if (TERMINAL_STATES.has(run.state)) {
      return { kind: "terminal", run };
    }

    // Read progress.json while working
    if (run.state === "working") {
      try {
        const progBuf = await client.readWorkspaceFile(started.runId, "progress.json");
        if (progBuf) {
          const prog = JSON.parse(progBuf.toString("utf8"));
          const phase = typeof prog?.phase === "string" ? prog.phase : "";
          const step = typeof prog?.step === "string" ? prog.step : "";
          const key = `${phase}:${step}`;
          if (step && key !== lastProgressKey) {
            lastProgressKey = key;
            logInfo(`Progress [${phase || "working"}]: ${step}`);
          }
        }
      } catch {
        // progress.json is optional and best-effort
      }
    }
  }

  return { kind: "timeout" };
}

async function runReviewOnGateway({
  client,
  opts,
  brief,
  attachments,
  stagedArchivePath,
}) {
  const startedAt = Date.now();
  let liveRunId = null;
  const runIdsToClean = new Set();

  const onSignal = async (sig) => {
    logWarn(`Received ${sig}; canceling active review run...`);
    if (liveRunId) {
      try {
        await client.cancelRun(liveRunId);
      } catch {
        // ignore
      }
      if (!opts.keepWorkspace) {
        try {
          await client.deleteWorkspace(liveRunId);
        } catch {
          // ignore
        }
      }
    }
    process.exit(130);
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    let selectedAgentId = opts.agentId || null;

    logInfo(
      `Starting review run on ${selectedAgentId ? (AGENT_NAMES_BY_ID.get(selectedAgentId) ?? selectedAgentId) : "Lobster Code Review pool (round-robin)"}...`,
    );

    // When a local archive > 3 MiB must be streamed via transfer_workspace_file,
    // follow the prepare-then-steer pattern from tasks.ts: start the workspace
    // with a staging message, upload repo-head.tar.gz using a one-time 15-minute
    // SHA256-pinned upload ticket, then steer the run with the full review brief.
    const initialMessage = stagedArchivePath
      ? [
          "Prepare `/home/node/workspace` for a local-only code review:",
          'write `{"phase":"cloning","step":"Waiting for local repository snapshot upload"}` to `/home/node/workspace/progress.json` and end your turn immediately without doing any other work.',
          "The repository archive (`repo-head.tar.gz`) and full review brief will arrive in the next message.",
        ].join(" ")
      : brief;

    const started = await client.startRun(selectedAgentId, {
      message: initialMessage,
      attachments,
      preferredAgentId: selectedAgentId,
      onAgentSelected: (id) => {
        selectedAgentId = id;
      },
    });

    liveRunId = started.runId;
    runIdsToClean.add(started.runId);
    const agentDisplay =
      started.agentName ||
      AGENT_NAMES_BY_ID.get(started.agentId ?? "") ||
      started.agentId ||
      "Lobster Code Review Runtime";
    logInfo(`Run started: ${started.runId} on ${agentDisplay}`);
    logInfo(`Run URL: ${started.runUrl}`);

    let pollOutcome = await pollUntilTerminal(client, started);
    if (pollOutcome.kind === "timeout") {
      try {
        await client.cancelRun(started.runId);
      } catch {
        // ignore
      }
      throw new Error(`Review run ${started.runId} timed out after ${RUN_TIMEOUT_MS / 60_000}m.`);
    }

    let finalRun = pollOutcome.run;
    if (finalRun.state !== "completed") {
      const reason = finalRun.statusReason || finalRun.failure?.code || "no reason given";
      throw new Error(`Review run ${started.runId} ended in state "${finalRun.state}": ${reason}`);
    }

    if (stagedArchivePath) {
      logInfo(
        `Uploading local repository archive (${stagedArchivePath}) via one-off SHA256-pinned transfer ticket...`,
      );
      const uploaded = await client.uploadWorkspaceFile(
        started.runId,
        "repo-head.tar.gz",
        stagedArchivePath,
      );
      logInfo(
        `Uploaded repo-head.tar.gz (${(uploaded.size / (1024 * 1024)).toFixed(2)} MiB, sha256=${uploaded.sha256.slice(0, 12)}…); steering run with review brief...`,
      );
      await client.steerRun(started.runId, brief);
      pollOutcome = await pollUntilTerminal(client, started);
      if (pollOutcome.kind === "timeout") {
        try {
          await client.cancelRun(started.runId);
        } catch {
          // ignore
        }
        throw new Error(`Review run ${started.runId} timed out after ${RUN_TIMEOUT_MS / 60_000}m.`);
      }
      finalRun = pollOutcome.run;
      if (finalRun.state !== "completed") {
        const reason = finalRun.statusReason || finalRun.failure?.code || "no reason given";
        throw new Error(`Review run ${started.runId} ended in state "${finalRun.state}": ${reason}`);
      }
    }

    logInfo("Run completed; reading /home/node/workspace/review.json...");
    let contract = await readContract(client, started.runId, "review.json");

    // 1-turn repair steer if review.json is missing or invalid and workspace can continue
    if (!contract.ok && finalRun.workspace?.canContinue) {
      logWarn(`review.json invalid (${contract.reason}); steering run once to repair...`);
      const repairPrompt = [
        `The file /home/node/workspace/review.json is missing or invalid: ${contract.reason}.`,
        "Write valid JSON to /home/node/workspace/review.json matching the output contract in the prompt above now, and do nothing else.",
      ].join("\n\n");
      await client.steerRun(started.runId, repairPrompt);
      pollOutcome = await pollUntilTerminal(client, started);
      if (pollOutcome.kind === "terminal" && pollOutcome.run.state === "completed") {
        finalRun = pollOutcome.run;
        contract = await readContract(client, started.runId, "review.json");
      }
    }

    liveRunId = null;
    if (!contract.ok) {
      throw new Error(`Contract error on review.json: ${contract.reason}`);
    }

    return {
      review: contract.data,
      run: {
        runId: started.runId,
        runUrl: finalRun.runUrl || started.runUrl,
        agentId: finalRun.agentId || started.agentId,
        agentName:
          finalRun.agentName ||
          started.agentName ||
          AGENT_NAMES_BY_ID.get(finalRun.agentId || started.agentId || "") ||
          null,
        tier: finalRun.tier || started.tier || null,
        durationMs: Date.now() - startedAt,
      },
    };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (!opts.keepWorkspace) {
      for (const runId of runIdsToClean) {
        try {
          await client.deleteWorkspace(runId);
          logInfo(`Deleted remote runtime workspace for run ${runId}`);
        } catch (err) {
          logWarn(`Could not delete workspace for run ${runId}: ${err.message}`);
        }
      }
    }
  }
}

// ============================================================================
// Diff Indexing, Finding Placement & Excerpt Extraction
// ============================================================================

function headLines(patch) {
  const lines = new Map();
  let right = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      right = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      lines.set(right, line.slice(1));
      right++;
    }
  }
  return lines;
}

function buildDiffIndex(files) {
  const index = new Map();
  for (const file of files) {
    if (file.patch) index.set(file.filename, headLines(file.patch));
  }
  return index;
}

function isRangeInDiff(index, file, start, end) {
  const lines = index.get(file);
  if (!lines || end < start || end - start > MAX_RANGE_LINES) return false;
  for (let line = start; line <= end; line++) {
    if (!lines.has(line)) return false;
  }
  return true;
}

function excerptFromDiffOrRepo(index, target, finding) {
  const end = finding.end_line ?? finding.line;
  const last = Math.min(end, finding.line + MAX_EXCERPT_LINES - 1);
  const diffText = index.get(finding.file);
  if (diffText) {
    const lines = [];
    let allPresent = true;
    for (let n = finding.line; n <= last; n++) {
      const line = diffText.get(n);
      if (line === undefined) {
        allPresent = false;
        break;
      }
      lines.push(line);
    }
    if (allPresent && lines.length > 0) {
      if (end > last) lines.push("…");
      const excerpt = lines.join("\n");
      return excerpt.length > MAX_EXCERPT_CHARS
        ? `${excerpt.slice(0, MAX_EXCERPT_CHARS - 1)}…`
        : excerpt;
    }
  }

  // Fallback: read directly from local checkout file if present
  const localFilePath = resolve(target.repoDir, finding.file);
  if (localFilePath.startsWith(`${target.repoDir}/`) && existsSync(localFilePath)) {
    try {
      const fileLines = readFileSync(localFilePath, "utf8").split("\n");
      if (finding.line >= 1 && finding.line <= fileLines.length) {
        const slice = fileLines.slice(finding.line - 1, Math.min(last, fileLines.length));
        if (end > last) slice.push("…");
        const excerpt = slice.join("\n");
        return excerpt.length > MAX_EXCERPT_CHARS
          ? `${excerpt.slice(0, MAX_EXCERPT_CHARS - 1)}…`
          : excerpt;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function placeFindings(rawFindings, diffIndex, target) {
  const sorted = [...rawFindings].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9),
  );
  return sorted.map((finding, idx) => {
    const end = finding.end_line ?? finding.line;
    const inline = isRangeInDiff(diffIndex, finding.file, finding.line, end);
    const excerpt = excerptFromDiffOrRepo(diffIndex, target, finding);
    return {
      n: idx + 1,
      ...finding,
      blocking: BLOCKING_SEVERITIES.has(finding.severity),
      inline,
      excerpt,
    };
  });
}

function verdictFor(findings) {
  if (findings.some((f) => BLOCKING_SEVERITIES.has(f.severity))) {
    return "request_changes";
  }
  return findings.length > 0 ? "comment" : "approve";
}

function verdictHeadlineFor(verdict) {
  if (verdict === "approve") return "Looks good to merge";
  if (verdict === "comment") return "Nothing blocks the merge";
  return "Needs changes before merge";
}

function computeFindingCounts(findings) {
  const counts = {
    total: findings.length,
    blocking: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    nit: 0,
    inline: 0,
    fileLevel: 0,
  };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    if (BLOCKING_SEVERITIES.has(f.severity)) counts.blocking++;
    if (f.inline) counts.inline++;
    else counts.fileLevel++;
  }
  return counts;
}

function computeDelta(previousFindings, reviewPrevious, currentFindings) {
  if (!previousFindings || previousFindings.length === 0) return null;
  const previousIds = new Set(previousFindings.map((f) => f.id));
  const statusById = new Map((reviewPrevious ?? []).map((p) => [p.id, p.status]));
  const currentIds = new Set(currentFindings.map((f) => f.id));
  let fixed = 0;
  let open = 0;
  let superseded = 0;
  for (const id of previousIds) {
    const status = statusById.get(id) ?? (currentIds.has(id) ? "open" : "fixed");
    if (status === "open") open++;
    else if (status === "superseded") superseded++;
    else fixed++;
  }
  let added = 0;
  for (const f of currentFindings) {
    if (!previousIds.has(f.id)) added++;
  }
  return { fixed, open, new: added, superseded };
}

// ============================================================================
// Formatting Outputs (Model/Agent Structured JSON + Operator Chat Markdown)
// ============================================================================

function formatDuration(ms) {
  if (!ms || ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function fileDiffUrl(repoUrl, prNumber, filePath, line, endLine) {
  const hash = createHash("sha256").update(filePath).digest("hex");
  const end = endLine ?? line;
  return `${repoUrl}/pull/${prNumber}/files#diff-${hash}R${line}${end > line ? `-R${end}` : ""}`;
}

function fileBlobUrl(repoUrl, sha, filePath, line, endLine) {
  const encodedPath = filePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const end = endLine ?? line;
  return `${repoUrl}/blob/${sha}/${encodedPath}#L${line}${end > line ? `-L${end}` : ""}`;
}

function formatFindingLocationLink(target, finding, inTable = false) {
  const end = finding.end_line ?? finding.line;
  const rangeStr = `${finding.file}:${finding.line}${end > finding.line ? `-${end}` : ""}`;
  const label = inTable ? `\`${rangeStr.replace(/\|/g, "\\|")}\`` : `\`${rangeStr}\``;
  const localPath = resolve(target.repoDir, finding.file);
  if (existsSync(localPath)) {
    return `[${label}](file://${localPath}#L${finding.line}-L${end})`;
  }
  if (target.number > 0 && finding.inline) {
    return `[${label}](${fileDiffUrl(target.repoUrl, target.number, finding.file, finding.line, end)})`;
  }
  return `[${label}](${fileBlobUrl(target.repoUrl, target.headSha, finding.file, finding.line, end)})`;
}

function renderOperatorChatReport(payload) {
  const { target, run, verdict, verdictHeadline, counts, delta, review } = payload;
  const lines = [];

  const verdictIcon =
    verdict === "approve" ? "✅" : verdict === "comment" ? "💬" : "❌";
  const headlineSuffix = review.title ? ` — ${review.title}` : "";
  lines.push(`## ${verdictIcon} Archestra Code Review: ${verdictHeadline}${headlineSuffix}`);
  lines.push("");

  // Metadata summary bar
  const targetDesc =
    target.number > 0
      ? `[${target.repository}#${target.number}](${target.url}) (\`${target.headRef}\` → \`${target.baseRef}\`, \`${target.headSha.slice(0, 7)}\`)`
      : `\`${target.repository}\` (\`${target.headRef}\` → \`${target.baseRef}\`, \`${target.headSha.slice(0, 7)}\`${target.localOnly ? ", local unpushed" : ""})`;
  const metaParts = [`**Target:** ${targetDesc}`];
  if (run?.agentName) metaParts.push(`**Reviewer:** ${run.agentName}`);
  if (run?.durationMs) metaParts.push(`**Duration:** ${formatDuration(run.durationMs)}`);
  if (run?.runUrl) metaParts.push(`[Archestra Run](${run.runUrl})`);
  lines.push(metaParts.join(" · "));
  lines.push("");

  // Counts summary
  if (counts.total === 0) {
    lines.push("**Findings:** None (0 findings)");
  } else {
    const sevParts = SEVERITIES.filter((s) => counts[s] > 0).map(
      (s) => `${counts[s]} ${SEVERITY_LABELS[s].toLowerCase()}`,
    );
    const blockingLabel =
      counts.blocking > 0 ? `**${counts.blocking} blocking**` : "0 blocking";
    lines.push(`**Findings:** ${counts.total} total (${blockingLabel} — ${sevParts.join(", ")})`);
  }
  lines.push("");

  // What to do first / Conclusion
  if (review.conclusion) {
    if (verdict === "request_changes") {
      lines.push(`> **What to do first:** ${review.conclusion}`);
    } else {
      lines.push(`> **Conclusion:** ${review.conclusion}`);
    }
    lines.push("");
  }

  // Delta since previous review
  if (delta && (delta.fixed > 0 || delta.open > 0 || delta.new > 0 || delta.superseded > 0)) {
    const parts = [];
    if (delta.fixed > 0) parts.push(`${delta.fixed} fixed`);
    if (delta.open > 0) parts.push(`${delta.open} still open`);
    if (delta.new > 0) parts.push(`${delta.new} new`);
    if (delta.superseded > 0) parts.push(`${delta.superseded} superseded`);
    lines.push(`**Since the last review:** ${parts.join(" · ")}`);
    if (review.previous?.length > 0) {
      lines.push("");
      for (const p of review.previous) {
        const badge = p.status === "fixed" ? "✅ fixed" : p.status === "open" ? "⚠️ open" : "➖ superseded";
        lines.push(`- \`${p.id}\`: **${badge}**${p.note ? ` — ${p.note}` : ""}`);
      }
    }
    lines.push("");
  }

  // Summary
  lines.push("### Summary");
  lines.push("");
  lines.push(review.summary);
  lines.push("");

  // Findings table + detailed cards
  if (review.findings.length > 0) {
    lines.push("### Findings");
    lines.push("");
    lines.push("| # | Severity | Finding | Location |");
    lines.push("| :--- | :--- | :--- | :--- |");
    for (const f of review.findings) {
      const sevBadge = f.blocking ? `**${SEVERITY_LABELS[f.severity]}**` : SEVERITY_LABELS[f.severity];
      const titleCell = f.title.replace(/\|/g, "\\|");
      const locCell = formatFindingLocationLink(target, f, true);
      lines.push(`| ${f.n} | ${sevBadge} | ${titleCell} (\`${f.id}\`) | ${locCell} |`);
    }
    lines.push("");

    for (const f of review.findings) {
      const loc = formatFindingLocationLink(target, f, false);
      const blockingTag = f.blocking ? " (blocking)" : "";
      lines.push(`#### #${f.n} · [${SEVERITY_LABELS[f.severity]}${blockingTag}] ${f.title}`);
      lines.push(`- **ID:** \`${f.id}\``);
      lines.push(`- **Location:** ${loc}`);
      lines.push("");
      if (f.excerpt) {
        lines.push("```");
        lines.push(f.excerpt);
        lines.push("```");
        lines.push("");
      }
      lines.push(f.summary);
      lines.push("");
      if (f.failure_scenario) {
        lines.push(`**How it breaks:** ${f.failure_scenario}`);
        lines.push("");
      }
      lines.push(`**Recommendation:** ${f.recommendation}`);
      lines.push("");
      if (f.suggestion !== undefined) {
        lines.push("**Suggested replacement:**");
        lines.push("```suggestion");
        lines.push(f.suggestion);
        lines.push("```");
        lines.push("");
      }
    }
  }

  // Review Notes
  lines.push("### Review Notes");
  lines.push("");
  if (review.changes.length > 0) {
    lines.push("#### Change Map");
    lines.push("");
    lines.push("| File | Change |");
    lines.push("| :--- | :--- |");
    for (const c of review.changes) {
      lines.push(`| \`${c.file.replace(/\|/g, "\\|")}\` | ${c.summary.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  if (review.reviewed.length > 0) {
    lines.push("#### Reviewed");
    for (const item of review.reviewed) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  if (review.observations.length > 0) {
    lines.push("#### Observations");
    for (const obs of review.observations) {
      lines.push(`- ${obs}`);
    }
    lines.push("");
  }
  if (review.tests.length > 0 || review.coverage) {
    lines.push("#### Tests & Coverage");
    for (const t of review.tests) {
      lines.push(`- ${t}`);
    }
    if (review.coverage) {
      lines.push(`- **Coverage:** ${review.coverage}`);
    }
    lines.push("");
  }
  if (review.limitations) {
    lines.push(`#### Not Covered / Limitations\n\n${review.limitations}\n`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

// ============================================================================
// Main Execution
// ============================================================================

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = resolveGitTarget(opts);

  const outputDir =
    opts.outputDir || mkdtempSync(join(tmpdir(), "archestra-code-review-"));
  mkdirSync(outputDir, { recursive: true });

  logInfo(
    `Target: ${target.repository} (${target.headRef} @ ${target.headSha.slice(0, 7)} <- ${target.baseRef} @ ${target.baseSha.slice(0, 7)}, ${target.changedFiles.length} changed file(s))`,
  );

  if (target.changedFiles.length === 0) {
    const emptyPayload = {
      status: "nothing-to-do",
      verdict: "approve",
      verdictHeadline: "No changes to review",
      blocking: false,
      counts: computeFindingCounts([]),
      delta: null,
      run: null,
      target: {
        repoDir: target.repoDir,
        repository: target.repository,
        number: target.number,
        url: target.url,
        title: target.title,
        baseRef: target.baseRef,
        baseSha: target.baseSha,
        headRef: target.headRef,
        headSha: target.headSha,
        localOnly: !target.headOnRemote,
        includedUncommitted: target.includeUncommitted,
        changedFilesCount: 0,
      },
      review: {
        title: "No changes between base and head",
        summary: `No files changed between ${target.baseRef} (${target.baseSha.slice(0, 7)}) and ${target.headRef} (${target.headSha.slice(0, 7)}).`,
        conclusion: "There are no changes to review.",
        reviewed: [],
        changes: [],
        observations: [],
        tests: [],
        coverage: "",
        limitations: "",
        previous: [],
        findings: [],
      },
      findings: [],
    };
    const agentFindingsPath = join(outputDir, "agent-findings.json");
    const chatReportPath = join(outputDir, "chat-report.md");
    const chatReport = renderOperatorChatReport(emptyPayload);
    writeFileSync(agentFindingsPath, `${JSON.stringify(emptyPayload, null, 2)}\n`);
    writeFileSync(chatReportPath, chatReport);
    emitOutput(opts.format, emptyPayload, chatReport, { outputDir, agentFindingsPath, chatReportPath });
    return;
  }

  const checks = fetchCheckSnapshot(target);
  const previousFindings = loadPreviousFindings(target, opts);

  const {
    prJson,
    boundedDiffBuf,
    diffTruncated,
    attachments,
    brief,
    deliveryMode,
    stagedArchivePath,
  } = buildAttachmentsAndBrief(target, opts, checks, previousFindings, outputDir);

  // Persist prepared artifacts to outputDir for transparency & debugging
  writeFileSync(join(outputDir, "pr.json"), `${JSON.stringify(prJson, null, 2)}\n`);
  writeFileSync(join(outputDir, "pr.diff"), boundedDiffBuf);
  writeFileSync(join(outputDir, "brief.md"), brief);
  if (checks.length > 0) {
    writeFileSync(join(outputDir, "checks.json"), `${JSON.stringify(checks, null, 2)}\n`);
  }
  if (previousFindings.length > 0) {
    writeFileSync(
      join(outputDir, "previous-findings.json"),
      `${JSON.stringify(previousFindings, null, 2)}\n`,
    );
  }

  if (opts.dryRun) {
    const dryRunSummary = {
      status: "dry-run",
      outputDir,
      gatewayUrl: discoverCredentials(opts).primaryGatewayUrl,
      deliveryMode,
      stagedArchivePath,
      target: {
        repoDir: target.repoDir,
        repository: target.repository,
        number: target.number,
        url: target.url,
        title: target.title,
        baseRef: target.baseRef,
        baseSha: target.baseSha,
        headRef: target.headRef,
        headSha: target.headSha,
        localOnly: opts.localOnly || !target.headOnRemote,
        includedUncommitted: target.includeUncommitted,
        changedFilesCount: target.changedFiles.length,
        diffTruncated,
        checksCount: checks.length,
        previousFindingsCount: previousFindings.length,
        attachmentNames: attachments.map((a) => a.name),
      },
    };
    console.log(JSON.stringify(dryRunSummary, null, 2));
    return;
  }

  const client = await connectReviewClient(opts);
  const { review: rawReview, run } = await runReviewOnGateway({
    client,
    opts,
    brief,
    attachments,
    stagedArchivePath,
  });

  writeFileSync(join(outputDir, "review.json"), `${JSON.stringify(rawReview, null, 2)}\n`);

  const diffIndex = buildDiffIndex(target.changedFiles);
  const placedFindings = placeFindings(rawReview.findings, diffIndex, target);
  const verdict = verdictFor(placedFindings);
  const verdictHeadline = verdictHeadlineFor(verdict);
  const counts = computeFindingCounts(placedFindings);
  const delta = computeDelta(previousFindings, rawReview.previous, placedFindings);

  const payload = {
    status: "completed",
    verdict,
    verdictHeadline,
    blocking: verdict === "request_changes",
    counts,
    delta,
    run,
    target: {
      repoDir: target.repoDir,
      repository: target.repository,
      number: target.number,
      url: target.url,
      title: target.title,
      baseRef: target.baseRef,
      baseSha: target.baseSha,
      headRef: target.headRef,
      headSha: target.headSha,
      localOnly: !target.headOnRemote,
      includedUncommitted: target.includeUncommitted,
      changedFilesCount: target.changedFiles.length,
      diffTruncated,
    },
    review: {
      ...rawReview,
      findings: placedFindings,
    },
    findings: placedFindings,
  };

  const agentFindingsPath = join(outputDir, "agent-findings.json");
  const chatReportPath = join(outputDir, "chat-report.md");
  const chatReport = renderOperatorChatReport(payload);

  writeFileSync(agentFindingsPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(chatReportPath, chatReport);

  // Save to local git branch cache so subsequent runs on the same branch track delta automatically
  const cachePath = defaultPreviousCachePath(target);
  if (cachePath) {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, `${JSON.stringify(payload, null, 2)}\n`);
    } catch {
      // non-fatal if git dir is read-only
    }
  }

  emitOutput(opts.format, payload, chatReport, { outputDir, agentFindingsPath, chatReportPath });
}

function emitOutput(format, payload, chatReport, paths) {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ ...payload, artifacts: paths }, null, 2)}\n`);
    return;
  }
  if (format === "markdown") {
    process.stdout.write(chatReport);
    return;
  }
  // Default "both": User-friendly operator report first, then structured agent findings block
  process.stdout.write(chatReport);
  process.stdout.write("\n---\n\n");
  process.stdout.write("### Agent / Model Structured Findings (`agent-findings.json`)\n\n");
  process.stdout.write(`- **Output directory:** \`${paths.outputDir}\`\n`);
  process.stdout.write(`- **Structured JSON:** \`${paths.agentFindingsPath}\`\n`);
  process.stdout.write(`- **Operator Markdown:** \`${paths.chatReportPath}\`\n\n`);
  process.stdout.write("```json\n");
  process.stdout.write(
    JSON.stringify(
      {
        status: payload.status,
        verdict: payload.verdict,
        verdictHeadline: payload.verdictHeadline,
        blocking: payload.blocking,
        counts: payload.counts,
        delta: payload.delta,
        run: payload.run,
        target: payload.target,
        conclusion: payload.review.conclusion,
        findings: payload.review.findings,
        previous: payload.review.previous,
        limitations: payload.review.limitations,
        artifacts: paths,
      },
      null,
      2,
    ),
  );
  process.stdout.write("\n```\n");
}

main().catch((err) => {
  logWarn(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
