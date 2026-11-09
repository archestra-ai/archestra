---
name: archestra-code-review
description: Run the Archestra Code Review on demand for a local branch or pull request checkout via your single configured Archestra MCP gateway using a 100% local-only repository snapshot transfer (zero GitHub credentials required), producing both structured findings for the agent/model and a user-friendly review report to show the human operator in the model chat. Use when asked to run Archestra code review, Lobster review, review a local branch or PR checkout before or after opening a PR, or verify whether previous review findings are resolved.
---

# Archestra Code Review (`archestra-code-review`)

On-demand replacement for the org-wide `archestra-code-review` (`archestra-runtime-review.yml`) workflow and `archestra-ai/code-review-action`.

Instead of relying on the GitHub App (`archestra-lobster[bot]`) or GitHub Actions triggers, this skill runs the exact same Archestra code review directly from your agent runtime against any local branch or pull request checkout:

1. **Single MCP Gateway Connection**: Connects **only** to your existing configured Archestra MCP gateway (`archestra` staging MCP in `~/.gemini/config/mcp_config.json`, `~/.claude.json`, or `ARCHESTRA_MCP_GATEWAY_URL`) and routes through the **`Lobster Env Code Review` (`agent__lobster_env_code_review`)** load-balanced foreground router agent when assigned to your gateway, or falls back to round-robin with automatic failover across the 5 **Lobster Code Review** runtime subagents (`Claude Code`, `Codex`, `Grok`, `Kimi`, `Copilot`).
2. **100% Local-Only Workflow (Zero GitHub Credentials)**: Packages the local repository snapshot at `headSha` directly from your local checkout (`repo-head.tar.gz` + optional `uncommitted.patch`) and transfers it into `/home/node/workspace/repo` via inline `start_agent_run` attachments (`<= 3 MiB`) or a **one-off, short-lived (15-minute), SHA256-pinned HTTP upload ticket** minted by `archestra__transfer_workspace_file` (`> 3 MiB`). No GitHub token (`gh auth token`, PAT, or `CODE_REVIEW_GITHUB_TOKEN`) is ever read, transferred, or stored.
3. **Dual Outputs**:
   - **Structured Agent/Model Findings (`agent-findings.json`)** — machine-actionable review metadata, findings with diff placement (`inline` vs `file-level`), failure scenarios, recommendations, exact replacement suggestions, and delta tracking (`fixed`, `new`, `open`) so the agent can verify findings against the local checkout and fix them.
   - **User-Friendly Operator Report (`chat-report.md`)** — a formatted Markdown review report modeled after the Lobster PR review summary and inline cards, ready to display directly to the human operator in the model chat.

---

## Architecture & Parity with `archestra-code-review`

| Stage | Org Workflow (`archestra-runtime-review.yml` + `code-review-action`) | On-Demand Skill (`archestra-code-review`) |
| --- | --- | --- |
| **Target Resolution** | Triggered by `pull_request` / `issue_comment` event | Auto-detects current local branch, open PR (via `gh`), explicit PR `#`/`URL`, or `<base>..<head>` commit range; supports unpushed local commits and optional `--include-uncommitted` (`uncommitted.patch`) |
| **Attachments** | `pr.json`, `pr.diff`, `checks.json`, `previous-findings.json` | Identical attachments (`pr.json`, `pr.diff`, `checks.json`, `previous-findings.json`, `instructions.md`, `uncommitted.patch`) |
| **Repository Delivery** | Remote `git clone` with `CODE_REVIEW_GITHUB_TOKEN` | **100% local-only** (`repo-head.tar.gz` created from local git tree at `headSha`, delivered via inline attachment `<= 3 MiB` or one-off 15m SHA256-pinned `transfer_workspace_file` upload ticket `> 3 MiB`; zero GitHub credentials) |
| **MCP Gateway & Routing** | Separate `/v1/mcp/code-review` gateway | Reuses the caller's **single configured Archestra MCP gateway**, dispatching via `Lobster Env Code Review` (`agent__lobster_env_code_review`) server-side load balancing + failover (or direct round-robin across the 5 `Lobster Code Review` runtime subagents) |
| **Progress & Contract** | Polls `progress.json`, reads `review.json`, validates schema, sends 1 repair `steer_agent_run` turn if invalid, calls `delete_workspace` | Identical polling, `review.json` contract validation, 1-turn repair steer via `steer_agent_run`, and `delete_workspace` cleanup |
| **Output Delivery** | Posts sticky PR comment + GitHub PR review | Writes `agent-findings.json` (for agent verification/triage) and `chat-report.md` (to show the human operator in chat), and caches the result locally for delta tracking on re-reviews |

---

## Step 1: Locate or Materialize the Runner Script

The self-contained zero-dependency Node.js runner lives at:

- **In the `archestra` repo checkout**: `.agents/skills/archestra-code-review/scripts/archestra-code-review.mjs` (also accessible via `.claude/skills/archestra-code-review/scripts/archestra-code-review.mjs`)
- **In the marketplace plugin**: `/home/archestra/.gemini/config/archestra-marketplace/plugins/archestra-staging-default-skills/skills/archestra-code-review/scripts/archestra-code-review.mjs`
- **When loaded via `archestra__load_skill`**: If the skill was loaded dynamically via MCP and `scripts/archestra-code-review.mjs` is not yet on disk, write the `scripts/archestra-code-review.mjs` entry from the `archestra__load_skill` response `files` array to `/tmp/archestra-code-review.mjs` and run it with `node /tmp/archestra-code-review.mjs`.

---

## Step 2: Run the Archestra Code Review

Run `scripts/archestra-code-review.mjs` from the repository checkout (or pass `-C <repo-dir>`):

```bash
# 1. Review the current branch / PR checkout (100% local-only snapshot transfer)
node .agents/skills/archestra-code-review/scripts/archestra-code-review.mjs

# 2. Include uncommitted working-tree changes on top of HEAD (great before committing/pushing)
node .agents/skills/archestra-code-review/scripts/archestra-code-review.mjs --include-uncommitted

# 3. Review a specific PR by number or URL
node .agents/skills/archestra-code-review/scripts/archestra-code-review.mjs 1234
node .agents/skills/archestra-code-review/scripts/archestra-code-review.mjs https://github.com/archestra-ai/archestra/pull/1234

# 4. Review an explicit commit range or branch in another local repository checkout
node .agents/skills/archestra-code-review/scripts/archestra-code-review.mjs main..HEAD -C /path/to/repo

# 5. Pass extra focus instructions or target a specific Lobster review subagent
node .agents/skills/archestra-code-review/scripts/archestra-code-review.mjs \
  --instructions "Focus on multi-tenant authorization boundaries and SQL migration safety."
```

> **Execution note**: A remote Lobster code review run typically takes **1 to 4 minutes** while the review subagent unpacks the snapshot, inspects the changed files and surrounding callers, and writes `review.json`. Run the command with a sufficient timeout or allow it to run as a background command until completion.

### CLI Options Reference

| Flag | Description |
| --- | --- |
| `[target]` | Optional target: PR number (`123`, `#123`), PR URL, branch/ref, commit range (`base..head`), or repo directory path |
| `-C, --repo-dir <dir>` | Local git checkout directory (defaults to current working directory or `LOBSTER_ENV_REPOSITORY_DIR`) |
| `--pr <number\|url>` | Explicit GitHub pull request number or URL |
| `--base <ref>` | Base branch or commit SHA (auto-detected from PR or `origin/HEAD` / `main`) |
| `--head <ref>` | Head branch or commit SHA (default: `HEAD`) |
| `--include-uncommitted` | Include staged and unstaged working-tree changes on top of `HEAD` |
| `--local-only` | Package and transfer the local git tree at `headSha` directly into `/home/node/workspace/repo` with zero GitHub credentials (default) |
| `--public-clone` | Optional anonymous `git clone` + `head.bundle` fast path for public repositories (still uses zero credentials) |
| `--instructions <text>` | Extra focus instructions appended to the review brief |
| `--instructions-file <path>` | Path to a Markdown file with extra review instructions |
| `--previous-review <path>` | Explicit path to a prior `agent-findings.json` or `review.json` for delta tracking (`fixed` / `new` / `open`) |
| `--no-previous` | Start a fresh review without loading previous findings from local cache or PR sticky comment |
| `--agent-id <uuid\|tool>` | Target a specific Lobster Code Review subagent or router (`agent__lobster_env_code_review`) |
| `--output-dir <dir>` | Output directory for `agent-findings.json`, `chat-report.md`, `review.json`, and input artifacts |
| `--format <both\|markdown\|json>` | Stdout emission format (`both` emits `chat-report.md` followed by `agent-findings.json`) |
| `--dry-run` | Prepare `pr.json`, `pr.diff`, `repo-head.tar.gz`, `checks.json`, `previous-findings.json`, and `brief.md` without calling the MCP server |

### Single MCP Gateway & Subagent Pool

The runner uses **only your single configured Archestra MCP gateway connection** (resolved from `ARCHESTRA_MCP_GATEWAY_URL`, `~/.gemini/config/mcp_config.json`, or `~/.claude.json`):
- When **`Lobster Env Code Review` (`agent__lobster_env_code_review`)** is assigned as a subagent on your gateway, the runner automatically targets `agent__lobster_env_code_review`, and the backend load-balances and fails over across its assigned runtime subagents (`Lobster Code Review` pool).
- Otherwise, it distributes runs round-robin with automatic failover across the 5 `Lobster Code Review` runtime subagents:
  - `5ccca2af-4b5c-45f0-b05f-e5160c9103bc` (`Lobster Code Review Claude Code`)
  - `77393a44-a7f2-4d8e-b28f-bc48ccfeca95` (`Lobster Code Review Codex`)
  - `f7c55d1f-d69d-4f4f-b7a3-c8eb9b1ef955` (`Lobster Code Review Grok`)
  - `504b5c4a-0fe7-4344-8e19-5609df890673` (`Lobster Code Review Kimi`)
  - `f4c1274d-d149-4927-8997-9f1b7b8b2b03` (`Lobster Code Review Copilot`)

---

## Step 3: Process the Two Outputs (Required Agent Workflow)

Every run produces two artifacts in `--output-dir` (and prints both to stdout when `--format both` is used):

1. **`chat-report.md`** — User-friendly Markdown report for the human operator in the model chat
2. **`agent-findings.json`** — Structured findings for the agent/model to verify, triage, and fix

Follow both parts below whenever you run this skill.

### Part A: Agent/Model Verification & Triage (`agent-findings.json`)

`agent-findings.json` has the following structure:

```json
{
  "status": "completed",
  "verdict": "request_changes",
  "verdictHeadline": "Blocking issues found",
  "blocking": true,
  "counts": {
    "total": 1,
    "blocking": 1,
    "critical": 0,
    "high": 1,
    "medium": 0,
    "low": 0,
    "nit": 0,
    "inline": 1,
    "fileLevel": 0
  },
  "delta": {
    "fixed": [{ "id": "...", "severity": "high", "title": "...", "file": "...", "line": 10 }],
    "new": [{ "id": "stable-kebab-id", "severity": "high", "title": "...", "file": "path/to/file.ts", "line": 42 }],
    "open": []
  },
  "run": {
    "runId": "...",
    "runUrl": "https://frontend.archestra.dev/chat/runs/...",
    "agentId": "5ccca2af-4b5c-45f0-b05f-e5160c9103bc",
    "agentName": "Lobster Code Review Claude Code",
    "tier": null,
    "durationMs": 65000
  },
  "target": {
    "repoDir": "/home/archestra/archestra",
    "repository": "archestra-ai/archestra",
    "number": 1234,
    "url": "https://github.com/archestra-ai/archestra/pull/1234",
    "title": "feat: ...",
    "baseRef": "main",
    "baseSha": "...",
    "headRef": "feat/branch",
    "headSha": "...",
    "localOnly": false,
    "includedUncommitted": false,
    "changedFilesCount": 6,
    "diffTruncated": false
  },
  "findings": [
    {
      "n": 1,
      "id": "stable-kebab-id",
      "file": "path/to/file.ts",
      "line": 42,
      "end_line": 48,
      "severity": "high",
      "title": "...",
      "summary": "...",
      "failure_scenario": "...",
      "recommendation": "...",
      "suggestion": "...",
      "blocking": true,
      "inline": true,
      "excerpt": "..."
    }
  ]
}
```

**How the agent must use `agent-findings.json`:**
1. **Verify every finding against the local codebase**:
   - Read each finding's `file` inside `target.repoDir` around `line..end_line` (plus any callers or tests mentioned in `summary` and `failure_scenario`).
   - Do **not** blindly trust or blindly dismiss a finding — verify whether the failure scenario is reachable in the actual codebase.
2. **Classify each finding**:
   - `confirmed` — Real issue; either fix it immediately (if the user asked to fix review issues or you are iterating on your own changes) or highlight the concrete fix plan.
   - `needs_decision` — Valid tradeoff or product/architecture question that requires human operator input.
   - `false_positive` — Reviewer misread the code or surrounding invariants; record the exact file/line proof showing why it is safe.
3. **Re-run to verify fixes (when applicable)**:
   - After fixing blocking findings, re-run `archestra-code-review.mjs` (with `--include-uncommitted` if not yet committed, or after committing). The runner automatically loads the cached previous findings for the branch/PR and populates `delta.fixed`, `delta.new`, and `delta.stillOpen`.

### Part B: Human Operator Report in Model Chat (`chat-report.md`)

**Always show the human operator the user-friendly review report in the model chat:**
- Present the contents of `chat-report.md` directly in your response (do not collapse it into a one-line summary or hide the findings).
- Preserve clickable file links (`[file:start-end](file:///abs/path#Lstart-Lend)`) so the operator can jump directly to each finding in their editor.
- If you also verified or fixed findings in the same turn, append a short **Agent Triage & Actions Taken** section right below the report listing which findings were confirmed/fixed and which (if any) were verified as false positives with evidence.
