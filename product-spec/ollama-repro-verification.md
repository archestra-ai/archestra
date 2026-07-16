# Ollama issues — verification results (2026-07-16)

Results of executing [ollama-repro-runbook.md](./ollama-repro-runbook.md) end-to-end on a local dev machine. All three issues from [ollama-context-length-and-model-parameters.md](./ollama-context-length-and-model-parameters.md) reproduced against a live system.

## Environment

- macOS, Ollama 0.32.0 (Homebrew), `ollama serve` on `localhost:11434`
- Models: `qwen3:4b` (base) and custom `qwen3-8k` (`FROM qwen3:4b`, `PARAMETER num_ctx 8192`, `PARAMETER temperature 0.6`)
- Archestra dev environment via `tilt up` (frontend :3000, backend :9000, PostgreSQL in the `archestra-dev` k8s namespace)
- Ollama added as an org-scoped provider (no API key; backend default `http://localhost:11434/v1`); models synced automatically on provider creation
- Evidence conversations in the chat sidebar: "ollama repro" and "ollama repro output limit"

## Synced model state (DB)

```
    model_id     | context_length | output_length |                       default_parameters
-----------------+----------------+---------------+------------------------------------------------------------------
 qwen3:4b        |         262144 |               | {"stop": [...], "top_k": 20, "top_p": 0.95, "temperature": 0.6, ...}
 qwen3-8k:latest |         262144 |               | {..., "num_ctx": 8192, "temperature": 0.6, ...}
```

`qwen3:4b` reproduces the exact 262K-vs-8K scenario from the original report without needing the 120b model.

## Issue 1 — context mismatch: REPRODUCED (worse than documented)

A ~22k-token chat turn against `qwen3-8k` produced in the Ollama server log:

```
level=WARN msg="truncating input prompt" limit=4098 prompt=22414 keep=4 new=4098
```

llama.cpp truncates to the first `keep` tokens plus *half* the window, so the effective input limit was 4098, not even 8192 — over 80% of the prompt silently discarded. Archestra recorded the turn as `inputTokens: 4098` against a believed 262144 window (~2% used): no compaction, no overflow error, and the model answered a question about the discarded prompt beginning incorrectly.

## Issue 2 — 8k output fallback: REPRODUCED (request side)

`output_length` is NULL for both Ollama models; every chat request carried the fallback cap. Full parameter payload logged in `interactions` for a turn:

```json
{"model": "qwen3-8k:latest", "stream": true, "max_tokens": 8192, "tool_choice": "auto"}
```

Caveat found during verification: `qwen3:4b` itself refuses to generate more than ~1.7k tokens on prose/enumeration/repetition prompts (observed 832-1708 completion tokens, finish reason `stop`), so the mid-stream `length` cut was not triggered with this model. Observing the actual corruption needs the app-creation flow (`edit_app` HTML in tool-call arguments) or a larger long-form model — the original report used a 27b. The request-side proof (`max_tokens: 8192`) is model-independent and reliable.

## Issue 3 — parameters not applied: REPRODUCED

The model dialog shows `temperature 0.6`, `num_ctx 8192`, `top_p 0.95`, `top_k 20`, `stop` as read-only defaults; the actual request payload (above) contains none of them — only the computed (and wrong, per issue 2) `max_tokens`.

## Useful checks

```bash
# Synced model state
kubectl exec -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password \
  psql -U archestra -d archestra_dev \
  -c "SELECT model_id, context_length, output_length, default_parameters FROM models WHERE provider = 'ollama';"

# Exact parameters Archestra sent on the last LLM call
kubectl exec -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password \
  psql -U archestra -d archestra_dev -t -A \
  -c "SELECT (request::jsonb - 'messages' - 'tools' - 'system')::text FROM interactions ORDER BY created_at DESC LIMIT 1;"
```
