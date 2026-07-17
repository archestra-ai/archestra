# KB Embedding Improvement Plan

**Date:** 2026-07-17
**Status:** Draft for review
**Origin:** Bug report — KB query on a Bedrock/Anthropic-only org throws
`TypeError: Cannot read properties of undefined (reading 'map')` at
`backend/src/knowledge-base/embedding-clients/openai.ts:59`.

---

## Background (why these four items)

KB embedding uses a dedicated selection (`org.embeddingChatApiKeyId` +
`org.embeddingModel`), resolved in `kb-llm-client.ts:resolveEmbeddingConfig`.
Provider dispatch (`embedding-clients/index.ts:callEmbedding`) has branches for
`gemini`, `azure`, `ollama`, and **falls through to `callOpenAIEmbedding` for
every other provider** — assuming an OpenAI-shaped `/v1/embeddings` at the key's
base URL. That assumption is false for chat-only providers (anthropic, bedrock,
deepseek, perplexity, groq, cerebras, xai). A Bedrock key reaches the embedding
config because the only gate — front (`page.tsx` `embeddingCapableKeyIds`) and
back (`routes/organization.ts`) — is "does a synced model for this key have
`embeddingDimensions` set?", which an admin can satisfy manually in the model
editor. "Test Connection" is an optional, non-blocking button. Result: config
saves, then ingestion and query both crash on `response.data.map(...)`.

---

## Workstream 1 — Native Bedrock embeddings

**Goal:** let fully-AWS orgs embed with Bedrock instead of being forced onto
another provider.

- New client `embedding-clients/bedrock.ts` calling Bedrock **InvokeModel**
  (not the OpenAI-compatible family — Bedrock's OpenAI surface is
  ChatCompletions/Responses only; embeddings are Invoke-family). Reuse existing
  Bedrock credential/region resolution (`clients/bedrock-credentials.ts`,
  `bedrock-client.ts`, IAM/IRSA path).
- Models to support: Amazon Titan Text Embeddings (`amazon.titan-embed-text-v1`,
  `-v2:0`) and Cohere embeddings on Bedrock (`cohere.embed-english-v3`,
  `cohere.embed-multilingual-v3`). Request/response shapes differ per family —
  branch on model id.
- Wire `bedrock` into `callEmbedding` dispatch and
  `getEmbeddingDiscriminator` (new discriminator, e.g. `bedrock:embeddings`).
- Populate `embeddingDimensions` for these models during Bedrock model sync so
  they surface in the picker without manual marking (Titan v2 = 1024/512/256,
  Titan v1 = 1536, Cohere v3 = 1024).

**Open decision:** ship Titan first and add Cohere-on-Bedrock as a fast-follow,
or both together.

## Workstream 2 — Stop unconditional OpenAI fall-through

**Goal:** only route to the OpenAI-compatible client providers that actually
speak it; reject the rest.

- Add a single source of truth in `shared/model-constants.ts`, e.g.
  `PROVIDERS_SUPPORTING_OPENAI_COMPATIBLE_EMBEDDINGS`, and a combined
  `providerSupportsEmbeddings(provider)` that also accounts for the native
  clients (gemini, azure) and the new bedrock client.
- `callEmbedding` becomes **fail-closed**: a provider with no embedding client
  throws a typed error instead of falling through to OpenAI.
- **Verify the OpenAI-compatible list against each provider's live API before
  shipping** (this is a task, not an assumption):
  - Confirmed OpenAI-compatible embeddings: `openai`, `openrouter`, `vllm`,
    `ollama` (already branched).
  - Needs verification: `mistral` (mistral-embed via `/v1/embeddings`),
    `zhipuai`, `cohere` (only via a compat base URL — its native API is `/v2/embed`),
    `minimax`.
  - Excluded (no embeddings / not OpenAI-shaped): `anthropic`, `bedrock`
    (use WS1), `deepseek`, `perplexity`, `groq`, `cerebras`, `xai`;
    `github-copilot` / `microsoft-365-copilot` already blocked by the per-user
    guard.

## Workstream 3 — Graceful handling of malformed embedding responses

**Goal:** turn the raw `TypeError` into a clear, user-facing error.

- In `embedding-clients/openai.ts`, when `response.data` is missing or not an
  array, throw `OpenAIEmbeddingError` (status ~502) carrying the provider and
  model — instead of letting `.map` throw.
- Ensure the KB query path surfaces this as a **clear, actionable** message that
  names the offending provider/model, states the likely cause, and points to the
  fix (map the typed error at `query.ts` /
  `knowledge-management.ts:handleQueryKnowledgeSources` rather than leaking a
  500 stack). Target wording:
  > Failed to query knowledge base: the configured embedding provider
  > **{provider} / {model}** returned a response that isn't a valid embedding.
  > This usually means the provider doesn't support embeddings. Change the
  > embedding provider in Settings → Knowledge.

  (Avoid vague phrasings like "non supported embedding format" — the message
  must say which provider failed and what to do.)
- Same guarding applies to the ingestion path (`embedder.ts`) so a misconfigured
  embed fails loudly and diagnosably, not silently.

## Workstream 4 — Save validation covers embedding AND reranker, with progress + detailed errors

**Current gap:** the knowledge-settings PATCH (`routes/organization.ts:435-527`)
validates only the embedding key/model. The reranker fields
(`rerankerChatApiKeyId`, `rerankerModel`) are persisted with **no validation at
all**.

- **Backend:** on save, validate BOTH:
  - Embedding: provider is embedding-capable (WS2 allowlist) AND a live
    embedding round-trip succeeds (reuse the test-embedding call).
  - Reranker: key resolves AND the reranker model is usable for the chosen
    provider (a minimal rerank/generate probe).
  - Return a **structured, per-field result** (embedding: ok/fail + reason;
    reranker: ok/fail + reason) so the UI can show which half failed and why —
    not a single opaque 400.
- **Frontend:** clicking Save runs the checks and shows **progress** (e.g.
  "Checking embedding…", "Checking reranker…") and, on failure, the **detailed
  per-field error** returned by the backend. Save only persists once the
  relevant checks pass. (This makes the previously-optional "Test Connection"
  effectively part of Save.)

**Decisions:**
- Reranker is **optional**: leaving it empty is valid and saves fine. But if a
  reranker **is** configured, a failing reranker check **blocks** save — same as
  embedding. So: embedding always validated + blocks; reranker validated + blocks
  only when set.
- Round-trip validation for locked configs (embedding model is immutable once
  set) only runs for the fields actually changing.

---

## Validation / tests

- Unit: `callEmbedding` throws for a non-allowlisted provider (WS2).
- Unit: `callOpenAIEmbedding` throws `OpenAIEmbeddingError` (not `TypeError`)
  on a 2xx body lacking `data` (WS3).
- Unit: Bedrock embedding client returns a normalized `EmbeddingApiResponse`
  for Titan and Cohere response shapes (WS1).
- Route: knowledge-settings PATCH returns structured per-field errors for a
  chat-only embedding key and for an unresolvable reranker key (WS4).
- Route: query path maps the typed error to the user-facing
  "non supported embedding format" message (WS3).

## Out of scope

- Detecting and proactively surfacing orgs already stuck in the broken state
  (they need drop + reconfigure + re-ingest).
- The separate log-preview improvement (store first 3 floats of each embedding
  instead of `[]`) — tracked on its own.
