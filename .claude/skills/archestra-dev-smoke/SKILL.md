---
name: archestra-dev-smoke
description: Use to smoke-test an Archestra feature against a running localhost stack — drive a real chat turn through the API (real LLM call, read back the reply + tokens/cost) and/or capture headless screenshots of the web app to visually evaluate. Use when asked to test/verify/exercise a feature live, check chat works end to end, or screenshot and judge the UI.
---

# Archestra live smoke testing

Two ways to exercise a **running** local Archestra (`tilt up` / `pnpm dev`; frontend `:3000`,
backend `:9000`) the way a human would when checking a feature actually works:

- **Mode A — backend turn:** drive a real chat turn through the HTTP API (a real LLM call) and read
  the result back. For "does chat / this agent / this tool actually work end to end".
- **Mode B — visual:** screenshot pages headless, then **look at the PNGs and judge them**. For "does
  this page render / look right".

`$SKILL_DIR` is the directory containing this file. The backend helpers are zero-dependency Python
≥3.10 at `$SKILL_DIR/scripts/` — `python3 <script>` works with nothing installed.

This skill assumes the stack is already up and the instance already has a usable LLM provider key.
It does **not** start the stack, seed data, or create/edit LLM keys.

## Connect

Backend scripts read connection from env (defaults target local dev):

```bash
export ARCHESTRA_BASE_URL=http://localhost:3000   # frontend origin serves /api/* (default)
# auth: either an API key…
export ARCHESTRA_API_KEY=arch_...
# …or sign-in creds (default admin@example.com / password):
export ARCHESTRA_EMAIL=admin@example.com
export ARCHESTRA_PASSWORD=password
```

A failed connect prints a clear hint (stack down? wrong creds?). If you only need to confirm the
stack is reachable, run any Mode A command — it connect-checks first.

## Mode A — drive a real chat turn

```bash
python3 "$SKILL_DIR/scripts/chat_turn.py" --agent "My Assistant" --prompt "say hi in 3 words"
python3 "$SKILL_DIR/scripts/chat_turn.py" --agent <agent-uuid> --prompt "…" --json
```

`--agent` takes an agent name or id (list them in the UI under Agents, or via the client below).
It creates a conversation, sends the prompt, drains the stream (hard timeout — never hangs), then
reads the persisted assistant reply and the turn's interaction back, printing the **reply, tool
calls, model, and input/output tokens + cost**. Exit is non-zero if the turn errors or no reply
persists. Model is auto-resolved by the backend; pass `--model <id>` only to override.

If the turn fails because the instance has no LLM key configured, the script says so — fix it in the
UI (Settings → LLM), not here.

For features beyond a plain chat turn, compose `SmokeClient` directly — it exposes `list_agents`,
`list_llm_keys`, `create_conversation`, `run_turn`, and the read-back helpers:

```bash
python3 - <<'PY'
from smoke_client import SmokeClient
with SmokeClient("http://localhost:3000") as c:
    c.sign_in("admin@example.com", "password")
    for a in c.list_agents():
        print(a["name"], a["id"])
PY
```

(For the broader API surface — skills, MCP, policies, hooks — use the sibling
`migration-kit/scripts/archestra_client.py`.)

## Mode B — capture screenshots and evaluate

The Playwright capture lives in the e2e workspace so it reuses the installed browser and auth
helpers. Run it **from `platform/e2e-tests/`**:

```bash
SMOKE_PATHS=/agents,/settings pnpm exec playwright test --config smoke/smoke.config.ts
```

- `SMOKE_PATHS` — comma-separated app routes (default `/`).
- `SMOKE_OUT_DIR` — output dir for PNGs (default `/tmp/archestra-smoke`).

It signs in as admin, navigates each path, writes a full-page PNG per route, and prints a
`===SMOKE_MANIFEST===` JSON block listing each `{path, screenshot, errors}` (errors = console
errors / page exceptions seen on that route).

Then **do the evaluation yourself**: `Read` each PNG and judge it against what the feature should
look like — layout, content, empty/error states, and anything in the manifest's `errors`. The
capture only takes pictures; it asserts nothing about correctness.

## What this skill does not do

- Start or seed the stack (run `tilt up` / `pnpm dev` first).
- Create or edit LLM provider keys (configure them in the UI).
- Mock LLM calls — Mode A makes real calls and costs real tokens.
