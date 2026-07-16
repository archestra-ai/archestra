# Model parameter transparency & control — product spec (draft for team discussion)

Spec for issue 3 of [ollama-context-length-and-model-parameters.md](./ollama-context-length-and-model-parameters.md) (repro: [ollama-repro-runbook.md](./ollama-repro-runbook.md), issue 3). The ask: show which model parameters are actually being used, and allow controlling them (e.g. thinking budget). Currently Ollama's "recommended parameters" are shown read-only but nothing applies or controls any parameter.

This document lays out the design decisions and three packaged options (A/B/C) with a recommendation. Nothing here is built yet.

---

## Current state (confirmed, with code citations)

- **Chat request assembly** (`platform/backend/src/routes/chat/routes.ts:1183-1211`): the `streamText` config sets only
  - `maxOutputTokens` — always, via `resolveAgentMaxOutputTokens` (source of the issue-2 silent 8k fallback);
  - `temperature` — only when passed in the request body, which only the benchmark harness does (`routes.ts:279`);
  - `providerOptions` — only for Gemini image models (`responseModalities` hack, `routes.ts:1195-1201`).
  - No `top_p`, no `top_k`, no thinking/reasoning budget.
- **A2A path** (`platform/backend/src/agents/a2a-executor.ts:414-443`) sets even less: `maxOutputTokens` only. No temperature at all.
- **No thinking/reasoning support in chat.** The only `reasoning_effort` handling in the codebase is a passthrough default for external LLM-proxy clients (`platform/backend/src/routes/proxy/adapters/openai-codex-translator.ts:379-392`).
- **Ollama defaults are display-only by design.** `models.default_parameters` was added as deliberately display-only in PR #6352 (item "T4 — Auto-pull Ollama default parameters (display-only)"); schema comment "Display-only metadata; nothing applies these at request time" (`platform/backend/src/database/schemas/model.ts:135-140`); rendered read-only in the model edit dialog (`platform/frontend/src/app/llm/models/page.tsx:981-1015`).
- **No editable parameter surface exists.** `PatchModelBodySchema` allows only pricing / modalities / ignored / embeddingDimensions (`platform/backend/src/types/model.ts:128`). Agents carry `modelId`/`llmApiKeyId` but no sampling config (`platform/backend/src/database/schemas/agent.ts:87-100`).
- **The LLM proxy is a passthrough.** Proxy adapters (`platform/backend/src/routes/proxy/adapters/`) forward the client's own request body; they never read the model row for parameters. Sampling params on proxy traffic come from the client.
- **Model instance factory has no parameter seam.** `createLLMModel` (`platform/backend/src/clients/llm-client.ts:132-210`) takes apiKey/model/baseURL/headers only; parameters must be threaded through the `streamText` config, not the factory.

### Nuance worth stating: Ollama defaults are already applied — server-side

Ollama applies Modelfile `PARAMETER`s itself when the request omits them (that is exactly why issue 1's truncation triggers at `num_ctx 8192`). So the dialog copy "Archestra does not apply them to requests" is misleading twice over: the values *are* in effect (just not sent by Archestra), and the stored snapshot can go stale if the Modelfile changes after sync. Consequence for design: blindly re-sending the stored snapshot is mostly a no-op until it is stale — then it actively overrides the live server config with outdated values. Auto-applying stored defaults is therefore out of scope in every option below.

---

## Design decisions

### D1 — Where configured parameters live

| Choice | Pros | Cons |
|---|---|---|
| Per-model (extend `models` row + `PatchModelBodySchema` + existing edit dialog) | One place; admin-owned; dialog and PATCH route already exist | An edit affects every agent/user sharing the model |
| Per-agent (new config on `agentsTable`, next to existing `modelId`) | Same model, different tuning per use-case | New UI surface; doesn't cover ad-hoc model switching in chat |
| Layered: request body > agent > model | Most flexible | Needs a documented precedence chain and UI that explains the effective value |

### D2 — Which parameters, and how they map to providers

| Choice | Pros | Cons |
|---|---|---|
| Portable-only: `temperature`, `top_p`, `max_output_tokens` | First-class AI SDK `streamText` fields; work for every provider; no mapping layer | No thinking budget — doesn't fully answer the report |
| + Normalized `reasoning_effort: off\|low\|medium\|high` enum, mapped per provider | One UX concept; ~50-line mapping module → Anthropic `thinking.budgetTokens` (tiered), Gemini `thinkingConfig.thinkingBudget`, OpenAI `reasoningEffort`, Ollama `think` | Tier→budget values are opinionated; some models reject the field (needs per-model applicability) |
| + Raw `providerOptions` jsonb passthrough per model | Maximum power (`num_ctx`, `top_k`, exact `budgetTokens`) | Zero validation; a typo hard-fails every request for that model |

Caveats that make this the hard part: temperature ranges differ (OpenAI 0–2, Anthropic 0–1), reasoning models (o-series, GPT-5) reject `temperature` outright, and thinking budget is a different field and type per provider. The AI SDK drops unsupported portable params with a warning (already logged at `routes.ts:1242-1253`) rather than erroring, which is why the portable set is safe and `providerOptions` passthrough is not.

### D3 — "Show what's actually used"

- Split the model edit dialog into two sections:
  - **Applied to requests** — the editable configured values plus the computed effective `maxOutputTokens`;
  - **Reported by Ollama (reference)** — the existing read-only snapshot, with a copy-to-applied affordance (finally giving the reference display a job) and honest copy: these take effect server-side in Ollama unless overridden.
- Optional: an info popover on the chat model selector showing the effective parameters for the current conversation.
- Per-request ground truth remains the LLM proxy logs (`/llm/logs`) / `interactions` table.

### D4 — Does this affect LLM proxy traffic?

Recommendation: no, in all options. Proxy clients send their own parameters; injecting DB-configured defaults means merging into every adapter and silently rewriting what a client explicitly sent. If ever wanted, it is a separate project with its own precedence rules.

---

## Options

| | A — Minimal | B — Balanced (recommended) | C — Full |
|---|---|---|---|
| Storage (D1) | per-model jsonb | per-model jsonb | model + agent, layered (request > agent > model) |
| Params (D2) | `temperature`, `top_p`, `max_output_tokens` | A + normalized `reasoning_effort` | B + raw `providerOptions` jsonb |
| Transparency (D3) | two-section dialog | + chat selector popover | same as B |
| Thinking budget | no | yes (normalized) | yes (normalized + exact via passthrough) |
| Proxy traffic (D4) | untouched | untouched | untouched |
| Effort | ~1 day | ~2–3 days | ~1–2 weeks |

All options share the same core wiring:

1. New editable `configuredParameters` jsonb on the model row (typed Zod schema, not free-form), added to `PatchModelBodySchema` and the model edit dialog.
2. Applied in exactly two places, spread into the `streamText` config only when explicitly set: `routes.ts:1183-1211` and `a2a-executor.ts:414-443`. Precedence: request body > configured value > provider default.
3. `max_output_tokens` (when set) takes priority over the `resolveAgentMaxOutputTokens` computation — doubling as the manual escape hatch for issue 2's silent 8k fallback.
4. Internal LLM calls (title generation, compaction) do **not** honor configured parameters.

**Recommendation: B.** It fully answers the report (including thinking budget) without C's precedence chain and validation matrix; C's agent layer and passthrough are purely additive later.

## Out of scope (explicit)

- Auto-applying Ollama's stored `default_parameters` (stale-snapshot trap; already applied server-side by Ollama).
- `num_ctx` / context length — that is issue 1 (input context sync), not a sampling parameter.
- Per-agent overrides, raw `providerOptions` passthrough — deferred to option C.
- Injecting parameters into LLM proxy traffic (D4).
- Per-conversation / per-message parameter controls in the chat UI.

## Open questions for the team

1. Which option — A, B, or C?
2. For `reasoning_effort`: where do the tier→budget-token values come from for Anthropic/Gemini (fixed table vs fraction of `output_length`), and how do we mark models where the field is unsupported?
3. Confirm: internal LLM calls (title-gen, compaction) stay on defaults?
4. Should the model edit dialog's parameter section be visible to all providers from day one, or Ollama-first?
