# OpenAPPA Root Flow Qualification Runbook

This runbook qualifies the OpenAPPA **root tool flow** in the Archestra LLM
proxy against the four supported clients — Claude Code, Codex, OpenCode and
Archestra Chat — on a running development stack. A human or an agent executes
it.

> **The acceptance-plan path is automated.** The Archestra Chat scenario
> (deny → `get_remedy_plans` notice → ruling → `execute_remedy_plan` →
> retry) runs in CI as `platform/e2e-tests/tests/openappa/root-remedy-flow.spec.ts`
> in the `openappa` Playwright project. It mocks only the upstream Anthropic
> Messages API via WireMock.
>
> Other scenarios require manual execution: third-party CLIs, sanitizer and
> authority paths (S2, S3, S4), and the unconfigured tool path (S5).

## What this proves

The proxy replaces a denied tool call with `get_remedy_plans`. The notice carries the blocked call and the ruling in plain text. The proxy restores the notice on subsequent requests without database state. The model selects a remedy and executes it using `execute_remedy_plan` via the Archestra MCP gateway.

This verifies the end-to-end flow with the real client, LLM proxy, OpenAPPA runtime, MCP gateway, and provider. One policy covers all clients because the proxy submits client-specific tool names.

## What it deliberately mocks

Exactly one boundary: the policy's **external authority and its two sanitizers**
(`externals-fixture.mjs`). A real person on call, and a real redaction or
summarization service, would make the approve / deny / timeout / no-answer paths
untestable and non-deterministic. Nothing else is stubbed — there is no fake
provider, no fake gateway and no patched runtime.

---

## Prerequisites

1. A running Archestra stack (`tilt up` from `platform/`). Verify:
   - `tilt get uiresources` reports the stack up
   - `http://localhost:9000/health` answers
   - `http://localhost:3000` loads
  2. Enable OpenAPPA on the backend: set `ARCHESTRA_OPENAPPA_ENABLED=true` in
    `platform/.env`, and turn on the deployment-wide **Guardrails v2** switch
    in platform settings. The flag alone enforces nothing. When the flag
    is off, `http://localhost:3000/openappa` returns 404 and the proxy gates
    nothing. The offer signing key needs no manual setup: it derives from the
    auth secret, which Tilt defaults for local development.
3. The three client CLIs on `PATH` (Archestra Chat needs none — it is driven
   through its own API, see below). Record the versions you ran with in your
   report — the flags below were established against these:
   - `claude --version` (Claude Code)
   - `codex --version` (Codex)
   - `opencode --version` (OpenCode)
4. Provider credentials configured in Archestra: an Anthropic key (Claude Code
   runs `claude-sonnet-4-5-20250929` through `/v1/anthropic`) and an OpenAI key
   (OpenCode and Chat run `gpt-4.1` through `/v1/openai`; Codex needs a model
   Codex itself has a catalog entry for — see "Client configuration").
5. `node` (for the externals fixture — it has no dependencies).

---

## Setup

Everything below is reproducible from a clean checkout. No file in this
directory contains a credential, and no runner reads one from a file.

### Step 1 — seed the lab

```bash
cd platform/e2e-tests/fixtures/appa-root-flow
./setup-lab.sh
```

It is idempotent and takes no credentials. It creates one directory tree under
`APPA_LAB_HOME` (default `${TMPDIR:-/tmp}/appa-root-flow`) and seeds the two
scenario files the policy names by absolute path:

| Path | Purpose |
| --- | --- |
| `$APPA_LAB_HOME/lab/secret.txt` | S1/S2 — holds a `LAB-SECRET-…` marker the `redactor` sanitizer rewrites |
| `$APPA_LAB_HOME/lab/report.txt` | S3 — prose long enough that the `summarize` sanitizer's replacement is visible |
| `$APPA_LAB_HOME/{claude,codex,opencode}/` | per-client config and state |
| `$APPA_LAB_HOME/transcripts/<client>/` | transcripts and stderr, one pair per session id |

`policy.appa.toml` names `/tmp/appa-root-flow/lab/...`. If your `TMPDIR` is set
(macOS sets one) the lab lands elsewhere; `setup-lab.sh` detects that and prints
the `sed` one-liner to retarget the policy before you install it.

### Step 2 — the agent id

The agent the LLM proxy runs under. It is the `:agentId` path segment in
`/v1/anthropic/{agentId}` and `/v1/openai/{agentId}`.

- UI: **Agents** (`http://localhost:3000/agents`) — open the agent, the id is in
  the URL.
- API: `GET /api/agents` (paginated) or `GET /api/agents/all`.

```bash
export ARCHESTRA_AGENT_ID=<uuid>
```

### Step 3 — the MCP gateway id

The gateway the clients register as an MCP server. It is the `:profileId` path
segment in `/v1/mcp/:profileId`, and accepts a UUID **or** the gateway's slug.

- UI: **MCP Gateways** (`http://localhost:3000/mcp/gateways`).
- The **Connect** page (`http://localhost:3000/connection`) renders a complete,
  copyable client snippet with this URL already filled in — the fastest route if
  you only want one working config.

```bash
export ARCHESTRA_GATEWAY_ID=<uuid-or-slug>
```

The runners register that server under the label `gw` and use
`ARCHESTRA_GATEWAY_LABEL` as an override. Any label works. The
"Client configuration" section explains why.

### Step 4 — a gateway bearer token

The personal platform token the gateway authenticates with
(`Authorization: Bearer …`). It does **not** grant platform API access.

- UI: **Account → MCP Gateway/A2A Gateway Token**
  (`http://localhost:3000/account/gateway-token`) → *Manage Token*.
- API: `GET /api/user-tokens/me/value` returns the value for the current
  session; `POST /api/user-tokens/me/rotate` mints a fresh one.

```bash
read -rs ARCHESTRA_GATEWAY_TOKEN && export ARCHESTRA_GATEWAY_TOKEN
```

`read -rs` keeps the value out of your shell history and off the screen.

### Step 5 — an LLM proxy credential

What the clients send as their provider API key to the Archestra proxy. Use a
**virtual key**.

- Provider key (the upstream credential the virtual key maps to):
  `POST /api/llm-provider-api-keys`, listed by
  `GET /api/llm-provider-api-keys`. UI: **Settings → LLM**
  (`http://localhost:3000/settings`).
- Virtual key: `POST /api/llm-virtual-keys`, listed by
  `GET /api/llm-virtual-keys`; read the value back with
  `GET /api/llm-virtual-keys/:id/value`.

```bash
read -rs ARCHESTRA_PROXY_KEY && export ARCHESTRA_PROXY_KEY
```

For a dev session to call those endpoints from `curl` without the browser, mint
one with the dev auto-login plugin — set
`ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL` in `platform/.env`, then:

```bash
curl -c cookies.txt -X POST http://localhost:9000/api/auth/dev-auto-login
curl -b cookies.txt http://localhost:9000/api/agents/all
```

It is hard-disabled when `NODE_ENV` is production.

### Step 6 — install the policy

`policy.appa.toml` is the **organization guardrails policy** (`organization.appa.toml`),
which is what the proxy reads for new conversations. Install it one of two ways:

- **UI** — `http://localhost:3000/openappa`, the OpenAPPA policy editor. Paste
  the file, validate, save.
- **API** — read the current policy and its revision, then write:

  ```bash
  curl -b cookies.txt http://localhost:9000/api/guardrails-policy
  # -> { ..., "revision": N, "content": "..." }

  jq -n --rawfile content policy.appa.toml --argjson rev N \
    '{content: $content, expectedRevision: $rev}' \
  | curl -b cookies.txt -X PUT http://localhost:9000/api/guardrails-policy \
      -H 'content-type: application/json' --data @-
  ```

  `POST /api/guardrails-policy/validate` checks a policy without applying it.
  `PUT` requires `toolPolicy:update` and fails on a stale `expectedRevision` —
  re-read and retry rather than forcing.

There is a third path an agent can use: the Archestra MCP tools
`get_guardrails_policy`, `validate_guardrails_policy` and
`update_guardrails_policy`. They are the same service behind the same
revision check.

**Existing conversations keep the policy they started with.** Always start a new
session id after changing the policy.

### Step 7 — start the externals fixture

```bash
node externals-fixture.mjs
```

It listens on `http://127.0.0.1:8899` (override with `APPA_FIXTURE_PORT`; the
`[externals]` block in `policy.appa.toml` must name the same port). It has four
modes, and one authority mode is live at a time:

| Mode | Behavior | What it exercises |
| --- | --- | --- |
| `approve` (default) | answers `{ruling: "approve"}` | S4 pass |
| `deny` | answers `{ruling: "deny"}` | S4 refusal |
| `timeout` | answers after 30s, outliving the policy's `timeout_ms` | S4 no-answer by timeout |
| `no_answer` | answers `503` | S4 no-answer by a reachable authority that will not rule |

```bash
curl -X POST http://127.0.0.1:8899/mode -H 'content-type: application/json' -d '{"mode":"deny"}'
curl http://127.0.0.1:8899/mode     # read the current mode
curl http://127.0.0.1:8899/calls    # every consult the fixture received
```

The two sanitizer endpoints are always live and do not depend on the mode:
`/sanitizer/redact` replaces every `LAB-SECRET-…` marker in the call's arguments,
and `/sanitizer/summarize` replaces a tool's output with a one-line summary.

---

## Running a scenario

Each runner takes a session id and a prompt, and optionally a transcript path:

```bash
./run-claude.sh   s1-claude   "<prompt>"  [transcript-path]
./run-codex.sh    s1-codex    "<prompt>"  [transcript-path]
./run-opencode.sh s1-opencode "<prompt>"  [transcript-path]
```

The session id names the OpenAPPA root on the provider traffic
(`X-Appa-Session-ID`), where the proxy scopes it to the lab credential. The
gateway resolves a remedy from the offer id alone, so the header on the gateway
traffic is optional; the scripts still send it, which is harmless. **Use a fresh
session id for every scenario.**

Transcripts and stderr land in `$APPA_LAB_HOME/transcripts/<client>/`. Cross-check
against **LLM Proxy Logs** (`http://localhost:3000/llm/logs`) and **MCP Gateway
Logs** (`http://localhost:3000/mcp/logs`).

---

## The five scenarios

Substitute your lab path for `<LAB>` (`$APPA_LAB_HOME/lab`).

### S1 — accept: a read that restricts the session

#### Prompt

> Read `<LAB>/secret.txt` and tell me what the marker in it is.

**What OpenAPPA should decide.** The policy gives this read
`audience = ["lab@archestra.local"]`. Reading it narrows the session's audience,
so the call is blocked and offered an **acceptance plan** — the session may
proceed if it accepts the restriction.

**Pass condition.** The transcript shows the client calling
`get_remedy_plans` in place of the `Read`/`read`, the model executing the
acceptance offer via `execute_remedy_plan`, and the retried read succeeding.
The marker reaches the model.

### S2 — input sanitizer: carrying that content out

#### Prompt

> Read `<LAB>/secret.txt`, then write its contents to `<LAB>/out.txt`.
>
> (Codex: *Read `<LAB>/secret.txt`, then create `<LAB>/out.txt` with its
> contents. Create the file with your apply_patch tool, not with a shell
> command.* Codex has no dedicated write tool. Left to choose, it copies the
> file with `cp`, which is one shell call that the S1 rule admits and that
> carries nothing through a governed sink, so the sanitizer never runs.)

**What OpenAPPA should decide.** The write requires
`audience contains ["public"]`, and the session's audience is the lab. The
`redactor` input sanitizer permits `lab@archestra.local → public`, so the offered
remedy is to run it: it **rewrites the call's arguments** and releases the call.

**Pass condition.** `out.txt` exists and contains
`[redacted by the redactor]` where the `LAB-SECRET-…` marker was. The fixture's
`/calls` shows one `/sanitizer/redact` consult whose `artifact.body` is the
call's arguments as a JSON string.

### S3 — output sanitizer: staging a tool's result

#### Prompt

> Read `<LAB>/report.txt` and summarize it for me.

**What OpenAPPA should decide.** The policy marks this read
`trust = "untrusted"` and `[policy.deployment].confined_results` lists the read
tools, so the read's **output** is staged behind the `summarize` output
sanitizer (which permits `untrusted → trusted`) rather than the call being
blocked outright.

**Pass condition.** The model never sees the report prose. What it reports back
is the fixture's admitted value — `SUMMARY(<n> characters): the report was
summarized by the summarize sanitizer.` — and `/calls` shows one
`/sanitizer/summarize` consult carrying the file's text as `artifact.body`.

### S4 — authority: a sink a person must clear

#### Prompt

> Run `appa-publish --target staging` in the shell.

**What OpenAPPA should decide.** The policy requires
`attention = ["operator-signoff"]` for any command matching `*appa-publish*`, and
only the `operator` authority permits it. The call is blocked with a **consult**
plan pointing at the fixture.

**Pass condition**, one run per fixture mode with a fresh session id each time:

| Fixture mode | Expected |
| --- | --- |
| `approve` | the remedy succeeds and the command runs |
| `deny` | the remedy returns a denial; the command never runs |
| `timeout` | no answer — the runtime gives up after `timeout_ms`; the command never runs, and this is reported as *no answer*, not as a denial |
| `no_answer` | same: a reachable authority that refuses to rule is no answer, never a denial |

`GET /calls` must show exactly one `/authority` consult per run.

### S5 — planless: a tool the policy does not name

This one needs a tool the **client declares** and `policy.appa.toml` **does not
name**. Pick it per client and make sure the client itself will not refuse the
call first — a call the client blocks never reaches the proxy to be gated.

| Client | Tool to use | How to make the client offer it |
| --- | --- | --- |
| Claude Code | `WebFetch` | add `"WebFetch"` to the `--allowed-tools` list in `run-claude.sh` for this run only; leave the policy untouched |
| Codex | `spawn_agent` (the `multi_agent_v1` namespace; `gpt-5.6-luna` declares it) | the policy names every tool in Codex's `functions` namespace, `get_goal`, `create_goal` and `update_goal` included, and none in `multi_agent_v1`; check the declared tool list in the proxy log for your version and model, and pick a tool that is not in `policy.appa.toml` |
| OpenCode | `webfetch` | set `"webfetch": "allow"` in the permission block for this run only (it is `"deny"` otherwise) |

#### Prompt

> Fetch `https://example.com` and tell me the page title.
>
> (Codex: *Spawn a sub-agent that lists the files in this directory, using your
> spawn_agent tool, and report what it found.*)

**What OpenAPPA should decide.** A tool the policy does not name has no rule and
therefore no remedy. It is blocked with **no plan at all**.

**Pass condition.** The notice carries a denial with an empty set of offers, the
model is told there is no remedy, and it stops rather than looping on
`execute_remedy_plan`. No consult reaches the fixture — check `GET /calls` is
unchanged across the run.

If instead the call simply succeeds, the tool you picked *is* named in the
policy (or canonicalizes onto one that is); pick another and re-run with a fresh
session id.

---

## Archestra Chat

Chat is the fourth client and needs no runner script — it reaches the same flow
through the same proxy adapters, so you drive it with its own API.

**This scenario is the one CI automates.** The steps below are what
`platform/e2e-tests/tests/openappa/root-remedy-flow.spec.ts` performs against
a WireMock-scripted Anthropic upstream; run them by hand against a live
provider when you want to qualify the real thing.

Chat has no filesystem tools, so it runs S1 against a gateway tool instead. The
policy gives `archestra__list_skills` the same audience delta that `secret.txt`
carries for the other clients, so listing the skills is blocked with the same
acceptance plan.

1. Give the agent a model and a provider credential, or Chat has nothing to call:
   `PUT /api/agents/:id` with `{"modelId": "<id from GET /api/llm-models>",
   "llmApiKeyId": "<id from GET /api/llm-provider-api-keys>"}`. Both must be set;
   one alone is rejected.
2. Confirm the conversation sees both APPA tools:
   `GET /api/chat/agents/:agentId/mcp-tools` lists `archestra__get_remedy_plans`
   and `archestra__execute_remedy_plan`. The gateway advertises them implicitly
   while both switches are on — they are never assigned by hand.
3. Create a conversation (`POST /api/chat/conversations` with `{"agentId": …}`)
   and post a turn to `POST /api/chat` with
   `{"id": "<conversationId>", "trigger": "submit-message", "messages": [{"id":
   "m1", "role": "user", "parts": [{"type": "text", "text": "<prompt>"}]}]}`.
   The response is an SSE stream; read the `tool-input-available` and
   `tool-output-available` events.

Prompt: *"List the available skills using the list_skills tool. If the call is
blocked, read the remedy plans you are given, execute the offered plan with
execute_remedy_plan using its exact offer_id, and then retry list_skills."*

Pass condition: the stream shows three calls in this order. First,
`archestra__get_remedy_plans` with the blocked tool, its arguments, and the
ruling in plain text. Then, `archestra__execute_remedy_plan` with the exact
`offer_id` from the ruling. Last, `archestra__list_skills` with the real skill
list as its result. A conversation keeps the policy it started with, so always
start a new conversation after you install a policy.

### S1c — proving the acceptance changed the session

The round trip above proves the notice and the remedy. It does not prove the
*consequence*: that accepting the plan actually narrowed the session's
audience. The policy therefore requires a public audience for
`archestra__load_skill`, which Chat can reach, so the same call answers
differently before and after S1. Run all three turns in **one** conversation —
the label lives on the session, not the turn.

1. *"Load the appa-guide skill."* — allowed. The session is still public, so
   the call meets the requirement and the skill's instructions come back. This
   is the control: without it, a block in turn 3 proves nothing.
2. *"List the available skills."* — S1, as above: notice, remedy, released
   retry. The acceptance narrows the audience to `lab@archestra.local`.
3. *"Load the appa-guide skill."* — now blocked, with a ruling whose reason is
   *"the readers are not the public audience"*, offering the `redactor` input
   sanitizer. The sanitizer finds nothing to redact in `{"name":"appa-guide"}`,
   so the offer returns an `[appa] Authorized.` result with the same arguments.
   Verify those arguments and the successful retry. The runtime uses the same
   authorization result for unchanged and rewritten inputs.

Turn 1 succeeding and turn 3 blocking is the proof. Turn 3 blocking alone is
not: it would look identical if the tool had never been callable.

---

## Client configuration

Each of these was established by a live run. Removing one breaks the
qualification in the way noted.

| Client | Setting | Why |
| --- | --- | --- |
| Codex | `web_search = "disabled"` | Web search runs **inside** the provider, so the proxy rules on its result rather than its call, and the lab policy declares no `web_search` tool. Left on, a search the model chooses to run would be held as an unknown tool and derail the scenario. |
| Codex | `[features] code_mode_host = false` | Codex's code mode, on by default in recent builds, wraps every call in an `exec` program: the wire declares only `exec` and `wait`, so nothing can be gated and no notice tool exists. With it off, a model whose catalog entry allows direct tools declares them and the notice loop works. A model whose entry is `code_mode_only` (`gpt-5.6-luna`, for one) does not: Codex reports `Code Mode is unavailable because code-mode host is disabled`, still declares only `exec`, and the proxy refuses the session with `direct tool mode only`. Give such a model a catalog override, next row. |
| Codex | `tools.apply_patch_tool_type = "function"` (and `features.apply_patch_freeform=false`) | Codex's default free-form custom `apply_patch` carries one text argument. The proxy governs custom tools, but the function form keeps this qualification on the JSON path the other clients use. Flip this only when you are deliberately testing the free-form custom tool path. |
| Codex | a model Codex has a **catalog entry** for (`gpt-5.1-codex`; override with `ARCHESTRA_CODEX_MODEL`) | Two separate failures hide here. A model whose entry has `supports_search_tool = true` (`gpt-5.5`) defers its MCP tools to a provider-side tool search: the wire declares a `tool_search` tool and none of the APPA tools, and the proxy refuses the session with `defers its tools to a tool search`. A model Codex has no catalog entry for is worse, because it fails quietly: Codex logs `Model metadata for <model> not found. Defaulting to fallback metadata`, the session opens normally because the declaration does reach the proxy, and then Codex's own router rejects the notice call with `ERROR codex_core::tools::router: error=unsupported call: archestra__get_remedy_plans`. The run still reaches an answer — restoration supplies the ruling on the next request, which is the interrupted-notice path — so it looks like a pass unless you read the stderr. Confirm the gateway is advertising both tools (`tools/list` on `/v1/mcp/<gateway>` returns `archestra__get_remedy_plans` and `archestra__execute_remedy_plan`) before blaming the proxy. |
| Codex | `ARCHESTRA_CODEX_MODEL_CATALOG=<file>` for a `code_mode_only` or tool-search model | The runner writes the file's path to `model_catalog_json`, and Codex reads the model metadata from it instead of from its fetched catalog. Copy `~/.codex/models_cache.json`, and in the entry of the model you run set `tool_mode` to `"direct"` and `supports_search_tool` to `false`. The model then declares every tool inline, the APPA pair included, and the five scenarios run as on the other clients. Both `gpt-5.6-luna` and `gpt-5.5` were qualified this way. Codex drives some of these models over the lite Responses wire, which declares the tools as an `additional_tools` **input item** rather than a top-level `tools` list; the proxy reads that container too. |
| Codex | `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, `--dangerously-bypass-approvals-and-sandbox` | Headless: nothing is there to answer an approval prompt, and the sandbox would block the lab paths. |
| OpenCode | `"external_directory": "allow"` | The prompts name the scenario files by absolute path and the lab is not a project root, so OpenCode treats them as external and refuses to touch them — the call then never reaches the proxy to be gated. The runners `cd` into the lab first, but the live runs still needed this, so it stays. |
| OpenCode | `<label>_archestra__get_remedy_plans` / `…__execute_remedy_plan` set to `"allow"` | Headless mode cannot answer a permission prompt, so the notice and the remedy would stall. |
| Claude Code | prompt on **stdin**, not as a positional argument | `--allowed-tools` is variadic and would swallow a positional prompt as one more tool name. |
| Claude Code | `--strict-mcp-config --mcp-config <file>` | Pins the run to this harness's gateway registration and ignores the developer's own `~/.claude` MCP servers. |
| Claude Code | `MAX_THINKING_TOKENS=0` | Keeps transcripts readable and the runs cheap; thinking blocks are irrelevant to what is being qualified (restoration preserves them either way). |
| all three | the MCP server registered under **any** label (`gw` by default) | The gateway signs each tool description that it lists. The proxy verifies and removes that signature before parsing the request. A signed tool resolves to the advertised name regardless of client prefixes, such as `mcp__<label>__<tool>`, `<label>_<tool>`, or Codex namespace wrappers. The client label does not affect tool resolution. A server that copies tool names without a valid signature remains untrusted. |
| all three | `X-Appa-Session-ID` on the provider traffic | It names the OpenAPPA root, which the proxy scopes to the credential. The gateway resolves a remedy from the offer id, so a header there is optional. |

---

## Troubleshooting OpenAPPA 400 Responses

| Response | Cause | Fix |
| --- | --- | --- |
| `OpenAPPA cannot verify the … tools this session declares. Reconnect …` | The gateway tools carry invalid signatures. The client fetched tool lists before a deployment or secret rotation, or from a different deployment. | Reconnect the MCP server to the client (Claude Code: `/mcp`), then start a new session. |
| `OpenAPPA needs exactly one declaration of …` | The session declares a remedy tool more than once. Causes include the same gateway registered under two labels, multiple platform gateways in one client, or duplicate tool declarations. The message lists both spellings. | Register one platform gateway per client, using one label. |

## Troubleshooting Anthropic 401 Responses

If Claude Code receives 401 responses, verify `ARCHESTRA_ANTHROPIC_BASE_URL` in `platform/.env`.
Ensure it points to `https://api.anthropic.com` rather than an external aggregator.
Confirm the outbound destination in the backend logs:

```bash
tilt logs pnpm-dev-backend | grep 'outbound request headers'
```

Also ensure the client points to `/v1/anthropic/<agentId>`.
Requests to `/anthropic/v1/messages` without the `/v1` prefix return `401 Unauthenticated`.

## What this does not cover

- **CI, except the Chat acceptance-plan path.** That one scenario is automated
  (`platform/e2e-tests/tests/openappa/root-remedy-flow.spec.ts`, the
  `openappa` project). The rest is not, and cannot cheaply be: it needs live
  provider credentials and three third-party CLIs whose flags change between
  releases. The proxy-side unit and route tests
  (`platform/backend/src/openappa/`, `platform/backend/src/routes/proxy/llm-proxy-openappa.test.ts`,
  and `platform/backend/src/routes/proxy/llm-proxy-gateway-attestation.test.ts`
  for every client form under any label) are what pin the behavior; this
  harness proves the stock clients actually drive it.
- **Real authorities and real sanitizers.** The fixture stands in for both. A
  deployment's own HTTP authority is not exercised beyond the envelope shape.
- **Providers beyond Anthropic Messages and OpenAI Responses/Chat Completions.**
  The other proxy adapters are out of scope here.
- **Concurrency.** One session at a time, one scenario at a time. Nothing here
  probes interleaved roots or races between two clients on one session id.
- **Policy authoring, RBAC and revision conflicts.** Covered by the guardrails
  policy route tests, not by this runbook.
- **Long-horizon sessions.** Each scenario is a single one-shot prompt with a
  300s timeout. Restoration across many turns is exercised only incidentally.
