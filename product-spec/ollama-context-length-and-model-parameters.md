# Ollama context lengths & model parameter transparency

Analysis of three related reports about Ollama models in Archestra: the displayed input context length doesn't match what's configured in Ollama, the output token limit silently falls back to 8k and corrupts app creation, and model parameters shown in the UI aren't actually applied. This document captures the confirmed root causes (with code citations) and reproduction steps. Fixes are not decided yet — issue 1 has candidate fix options written up below; issue 3 explicitly calls for an implementation approach + team discussion before building.

---

## Issue 1 — Input context length not synced with Ollama

### Symptom

A model showed as 262K context in Archestra while Ollama had it configured to 8K input. The model (nemotron 120b) was failing even on simple apps, which was confusing because Archestra indicated plenty of context headroom.

### Root cause

Archestra reads the model's **architectural** context length, never the Ollama-**configured** one:

- The Ollama model fetcher calls `POST /api/show` and takes any `model_info` key ending in `.context_length` (e.g. `llama.context_length` = 262144 for Nemotron) — `platform/backend/src/routes/chat/model-fetchers/ollama.ts:146-147`.
- The configured `num_ctx` (from a Modelfile) is parsed into `defaultParameters`, which is explicitly display-only — `ollama.ts:148,185-208`; schema comment "nothing applies these at request time" at `platform/backend/src/database/schemas/model.ts:136-138`.
- A server-level context limit (Ollama app settings UI / `OLLAMA_CONTEXT_LENGTH` env) does not appear in `/api/show` at all, so Archestra cannot see it even as metadata.
- The architectural value is stored as `models.context_length` and drives everything: the model selector badge (`platform/frontend/src/components/chat/model-selector.tsx:257-281`), the chat context ring (`platform/frontend/src/app/chat/page.tsx:810-815`), the context-window breakdown (`platform/backend/src/routes/chat/context-window-breakdown.ts`), auto-compaction at 80% (`platform/backend/src/routes/chat/context-compaction.ts:521-542`), and overflow errors (`platform/backend/src/routes/chat/normalization/enforce-context-window-limit.ts:43-49`).

Consequence: with Ollama configured to 8K, Ollama **silently truncates the prompt** to 8K while Archestra believes the window is 262K — no compaction triggers, no overflow error is raised, and the model simply loses its earlier context (system prompt, tool schemas, conversation history) and starts failing.

### Reproduction steps

1. In Ollama, configure a small context for a model. Two variants:
   - Modelfile (visible to Archestra as metadata):
     `printf 'FROM qwen3:4b\nPARAMETER num_ctx 8192\n' > Modelfile && ollama create qwen3-8k -f Modelfile`
   - Server-level (completely invisible to Archestra): set the context length in the Ollama app settings, or run `OLLAMA_CONTEXT_LENGTH=8192 ollama serve`
2. Connect Ollama as a provider in Archestra and let models sync.
3. Open the chat model selector: the model shows its architectural context (e.g. 262K for `nemotron`, not 8K). Verify in the DB: `SELECT model_id, context_length, default_parameters FROM models WHERE provider = 'ollama';` — `context_length` holds the architectural value; for the Modelfile variant `default_parameters` contains `num_ctx: 8192` (stored, shown read-only, never used).
4. Run a conversation past ~8k tokens (paste a large file, or let big tool results accumulate).
5. Observe:
   - The Ollama server log prints its "truncating input prompt" message (limit=8192).
   - The model loses earlier instructions / tool schemas and starts failing even simple tasks (the reported Nemotron symptom).
   - Archestra's context ring / Context Window panel still shows plenty of free space (denominator 262k); auto-compaction never triggers (threshold is 0.8 × 262k) and no `ContextWindowExceededError` is raised.

### Fix options

Constraints that shape the options (verified 2026-07-16):

- All consumers (badge, context ring, compaction, overflow gate) read the single `models.context_length` value, so correcting the stored value fixes every surface at once.
- The configured `num_ctx` is already parsed into `defaultParameters` in the same function that decides `contextLength` (`platform/backend/src/routes/chat/model-fetchers/ollama.ts:146-148`), so it is available at the decision point.
- Server-level config (`OLLAMA_CONTEXT_LENGTH` env / app settings) does not appear in `/api/show`; recent Ollama versions expose the effective context of a *loaded* model via `/api/ps` (`context_length` per running model, reflecting the last load).
- Sending `num_ctx` per request is officially unsupported on Ollama's OpenAI-compatible `/v1/chat/completions` (PR [ollama/ollama#6137](https://github.com/ollama/ollama/pull/6137) rejected; docs recommend a Modelfile). A "control direction" fix would require switching to the native `/api/chat` endpoint — ruled out.
- Sync merge priority is `fetched ?? models.dev ?? inference` (`platform/backend/src/services/model-sync.ts:421-425`); for Ollama the fetched value always wins.

#### Option A — honor `num_ctx` during sync (minimal, recommended first step)

In `toFetchedCapabilities` (`ollama.ts:143-164`): when `defaultParameters.num_ctx` is a positive number, set `contextLength = min(architectural, num_ctx)`.

- Fixes the Modelfile-configured case (the reproduced runbook scenario) end-to-end; every consumer inherits the corrected value on the next model sync.
- Misses server-level config (invisible in `/api/show`) and Ollama's 4096 default when nothing is configured.
- Size: ~5 lines + unit test in the fetcher. No migration, no UI.

#### Option B — read effective context from `/api/ps`

During sync, additionally query `/api/ps`; for a currently loaded model, prefer its reported effective `context_length` over the architectural value.

- The only *automatic* way to see server-level env/app-settings limits.
- Caveats: value exists only while the model is loaded, reflects whatever the most recent load used, and requires a recent Ollama version — sync captures it opportunistically.
- Size: small-medium — one extra fetch + merge rule in the Ollama fetcher.

#### Option C — manual context length override (editable field)

Add an override (e.g. `custom_context_length` column, following the `customPricePerMillion*` pattern at `platform/backend/src/database/schemas/model.ts:94-122`) editable via `PATCH /api/llm-models/:id` (`PatchModelBodySchema`, `platform/backend/src/types/model.ts:132-141`) and the model edit dialog; effective value = `custom ?? synced`, so it survives re-sync by construction.

- Covers everything, including the invisible server-level case and wrong catalog data for *any* provider; also gives issue 2's `output_length` a home for the same treatment later.
- Size: migration + backend (schema, types, PATCH, effective-value resolution) + frontend dialog field.

#### Option D — runtime truncation detection (guardrail)

Ollama's response `usage.prompt_tokens` is the *post-truncation* count (`prompt_eval_count`). After a turn, compare it against Archestra's estimate of what was sent; if drastically lower, surface a warning on the turn ("Ollama truncated the prompt to N tokens") and optionally clamp the believed window.

- Fixes nothing proactively, but *detects* every variant at runtime — including cases A–C miss — with zero configuration.
- Caveats: heuristic (estimate vs. Ollama's tokenizer); needs a threshold to avoid false positives.
- Size: medium — post-turn check in the chat route + a UI notice.

#### Recommendation

A now (trivial, fixes the reproducible case), C as the follow-up covering the original reporter's likely server-level scenario. B and D are optional hardening.

---

## Issue 2 — Output token limit falls back to 8k and corrupts app creation

### Symptom

For `qwen3.6:27b-q8_0` Archestra used an 8k max output even though the model is capable of much more. Because the output limit is not shown anywhere, troubleshooting why apps were failing to assemble required digging through backend code.

### Root cause

- `resolveAgentMaxOutputTokens` (`platform/backend/src/agents/agent-output-budget.ts:16-23`) computes `min(ceiling, outputLength ?? 8192)`, where `UNKNOWN_MODEL_OUTPUT_TOKENS = 8192` (line 8) and the ceiling is `ARCHESTRA_CHAT_MAX_OUTPUT_TOKENS` (default 32768 — `platform/backend/src/config.ts:316,488-511,1543-1545`).
- `outputLength` is **always null for Ollama models**:
  - the Ollama fetcher never sets it (`ollama.ts:143-164` returns only `contextLength`, `embeddingDimensions`, `defaultParameters`);
  - capability inference for Ollama returns empty (`platform/backend/src/services/model-sync.ts:544`);
  - the models.dev catalog lookup is exact-match on `(provider, modelId)` (`platform/backend/src/models/model.ts:189-204`), so a local tag like `qwen3.6:27b-q8_0` never matches a catalog entry.
- Result: every Ollama model gets `maxOutputTokens = 8192`, applied at `platform/backend/src/routes/chat/routes.ts:1208-1211` and `platform/backend/src/agents/a2a-executor.ts:427-430` (the AI SDK maps it to Ollama's `num_predict`).
- The limit is displayed nowhere: the frontend has zero references to `outputLength` / `maxOutputTokens`; only `contextLength` is surfaced.
- App creation runs through the normal chat path and emits the **entire app HTML inside tool-call arguments** (`edit_app` `replacementHtml` / `edits[].new_str` — `platform/backend/src/archestra-mcp-server/apps.ts:152-187,796`). Any generation over ~8k output tokens is cut mid-stream, producing truncated tool-call JSON or an incomplete saved document — apps fail to assemble or render broken.

Note: raising `ARCHESTRA_CHAT_MAX_OUTPUT_TOKENS` does NOT help — it is only a ceiling; for an unknown model the effective value is still `min(ceiling, 8192) = 8192`.

### Reproduction steps

1. Use any Ollama model not present in the models.dev catalog under that exact id (e.g. `qwen3.6:27b-q8_0`; any quantization-tagged local model qualifies).
2. Verify the fallback: `SELECT model_id, output_length FROM models WHERE provider = 'ollama';` — `output_length` is NULL.
3. In chat with that model, create an app that needs a large document, e.g. "Build a single-page app: a full-featured kanban board with drag & drop, inline styles, no external libraries" (anything whose HTML exceeds ~8k output tokens).
4. Observe:
   - The `edit_app` tool call is truncated: invalid/incomplete JSON arguments, or a corrupted half-written HTML document; app creation fails or renders broken.
   - In the LLM proxy logs the request carries a max output of 8192 (`num_predict`) and the response ends with finish reason `length`.
5. Confirm the opacity: no place in the UI (models table, model edit dialog, chat) shows the effective 8192 limit.

---

## Issue 3 — Model parameter transparency

### Symptom / request

Show which model parameters are actually being used, and allow controlling them (e.g. thinking budget). Ollama's "recommended parameters" are displayed but are not actually applied.

### Current state (confirmed)

- Ollama's reported defaults (`num_ctx`, `temperature`, `stop`, ...) are fetched from `/api/show`, stored in `models.default_parameters`, and rendered read-only in the model edit dialog with copy that admits the gap: "Defaults reported by Ollama for this model, shown for reference. {appName} does not apply them to requests." — `platform/frontend/src/app/llm/models/page.tsx:981-1015`.
- What Archestra actually sends per chat turn (`platform/backend/src/routes/chat/routes.ts:1180-1211`): only `maxOutputTokens` (computed — see issue 2) and `temperature`, the latter only when passed in the request body, which only the benchmark harness does (`routes.ts:277-279`). No `top_p`, no `num_ctx`, no thinking budget, no reasoning effort.
- No per-model or per-agent parameter settings exist: `PatchModelBodySchema` allows only pricing / modalities / ignored / embeddingDimensions (`platform/backend/src/types/model.ts:128-227`); agent settings have no sampling fields.
- Thinking budget: nothing configures it anywhere; the only `reasoning_effort` handling is a passthrough for external LLM-proxy clients that send the field themselves (`platform/backend/src/routes/proxy/adapters/openai-codex-translator.ts:379-392`).

### Reproduction (demonstrating the gap)

1. Open LLM → Models → edit an Ollama model: the "Default parameters" section lists e.g. `temperature 0.6`, `num_ctx 8192`.
2. Send a chat message with that model, then inspect the request in the LLM proxy logs (or Ollama server logs): none of those parameters are present; only the computed max output tokens is set.

### Next step

This item is spec-first: figure out the implementation approach (where per-model / per-agent parameter overrides live; which parameters to expose — temperature, top_p, num_ctx, thinking budget; how they flow into the request), discuss with the team, and write a short product spec before building. The natural wiring point is the `streamTextConfig` assembly in `routes.ts:1180-1211` and `a2a-executor.ts:427-430`; storage candidates are an extension of `PatchModelBodySchema` / the model row, or agent config.
