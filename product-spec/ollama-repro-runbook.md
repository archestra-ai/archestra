# Ollama issues — local repro runbook (macOS)

Copy-paste reproduction for the three issues in [ollama-context-length-and-model-parameters.md](./ollama-context-length-and-model-parameters.md), tailored to a local dev machine (Homebrew, Tilt dev environment). One custom model (`qwen3-8k`) reproduces all three issues. All steps below were executed and verified on 2026-07-16 (Ollama 0.32.0); observed values are quoted verbatim.

## Setup (once, ~3 GB download)

```bash
# 1. Install and start Ollama (foreground terminal — its stdout shows the issue-1 truncation line)
brew install ollama
ollama serve

# 2. In another terminal: pull the base model and create the repro variant
ollama pull qwen3:4b
printf 'FROM qwen3:4b\nPARAMETER num_ctx 8192\nPARAMETER temperature 0.6\n' > /tmp/Modelfile.qwen3-8k
ollama create qwen3-8k -f /tmp/Modelfile.qwen3-8k

# 3. Start Archestra dev environment
cd platform && tilt up
```

Then connect the provider:

1. Open <http://localhost:3000/llm/model-providers>.
2. Add **Ollama** — no API key required; the backend defaults to `http://localhost:11434/v1`.
3. Model sync runs on creation. Confirm `qwen3-8k` and `qwen3:4b` appear under LLM → Models.

DB access for the verification queries below:

```bash
kubectl exec -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password \
  psql -U archestra -d archestra_dev \
  -c "SELECT model_id, context_length, output_length, default_parameters FROM models WHERE provider = 'ollama';"
```

Observed rows (verified):

```
    model_id     | context_length | output_length |                       default_parameters
-----------------+----------------+---------------+------------------------------------------------------------------
 qwen3:4b        |         262144 |               | {"stop": [...], "top_k": 20, "top_p": 0.95, "temperature": 0.6, ...}
 qwen3-8k:latest |         262144 |               | {..., "num_ctx": 8192, "temperature": 0.6, ...}
```

`context_length` is the architectural value 262144 (the exact 262K-vs-8K scenario from the original report), `output_length` is NULL, and the configured `num_ctx: 8192` sits display-only in `default_parameters`.

---

## Issue 1 — Input context length not synced with Ollama

Archestra displays the architectural context window; the Ollama-configured 8k `num_ctx` is stored as display-only metadata and never used.

1. In chat, select `qwen3-8k`. The model selector badge already shows the architectural context (262K), not 8K — that is the bug surface.
2. Push the conversation past 8k tokens: paste a large file (~100 KB of text ≈ 22k tokens) and ask a question about the beginning of it.
3. Watch both sides. Observed on this machine:
   - The `ollama serve` terminal printed:
     `level=WARN msg="truncating input prompt" limit=4098 prompt=22414 keep=4 new=4098`
     Note the limit is even *lower* than `num_ctx`: llama.cpp keeps the first `keep` tokens plus half the window, so an 8192 window truncated a 22414-token prompt down to 4098 tokens — over 80% of the prompt silently discarded.
   - Archestra recorded the turn as `inputTokens: 4098` (Ollama's post-truncation count) against a believed 262144 window; the context ring showed ~2% used, auto-compaction never triggered, no context-window error was raised, and the model answered the question about the discarded beginning incorrectly.

Server-level variant (worse — invisible even as metadata): stop `ollama serve` and run `OLLAMA_CONTEXT_LENGTH=8192 ollama serve`. Now even plain `qwen3:4b` truncates at 8k while Archestra has no way to know: the limit does not appear in `/api/show` at all, so `default_parameters` does not contain it either.

**Proves the bug:** Ollama logs truncation at 8192 while Archestra's context UI, compaction, and overflow checks all operate on ~40960.

---

## Issue 2 — Output token limit silently falls back to 8k

`qwen3-8k` is a local tag that cannot match the models.dev catalog, so `output_length` is NULL and every request gets `maxOutputTokens = min(32768, 8192) = 8192`.

1. Verify the fallback precondition with the DB query above: `output_length` is NULL for all Ollama models.
2. Send any chat message with `qwen3-8k`, then check what Archestra actually sent (this is the reliable, model-independent check):

   ```bash
   kubectl exec -n archestra-dev postgresql-0 -- env PGPASSWORD=archestra_dev_password \
     psql -U archestra -d archestra_dev -t -A \
     -c "SELECT (request::jsonb - 'messages' - 'tools' - 'system')::text FROM interactions ORDER BY created_at DESC LIMIT 1;"
   ```

   Observed (verified):

   ```json
   {"model": "qwen3-8k:latest", "stream": true, "max_tokens": 8192, "tool_choice": "auto"}
   ```

   `max_tokens: 8192` is the silent `UNKNOWN_MODEL_OUTPUT_TOKENS` fallback (the AI SDK maps it to Ollama `num_predict`). Same is visible in the LLM proxy logs UI (<http://localhost:3000/llm/logs>).
3. To see the actual mid-stream cut (finish reason `length`, corrupted output), the generation must genuinely exceed 8192 tokens. Caveat found during verification: `qwen3:4b` resists long-output prompts ("write 15000 words", enumerations, repetition — it stopped at 832-1708 completion tokens every time). Two working paths:
   - the original report's path: app creation via `edit_app` (thinking + full HTML document in tool-call arguments routinely exceeds 8k) — requires the apps tools assigned to the agent;
   - or a larger long-form model (the original report used a 27b).
4. Confirm the opacity: neither the models table, the model edit dialog, nor chat shows the effective 8192 limit anywhere. Raising `ARCHESTRA_CHAT_MAX_OUTPUT_TOKENS` does not help (it is only a ceiling; `min(32768, 8192) = 8192`).

**Proves the bug:** every request to a catalog-unknown Ollama model carries `max_tokens: 8192` regardless of the model's real capability, and no UI surface shows it.

---

## Issue 3 — Displayed model parameters are not applied

Ollama-reported defaults are stored and rendered read-only, but nothing applies them to requests.

1. Open LLM → Models → edit `qwen3-8k`. The "Default parameters" section lists `num_ctx 8192`, `temperature 0.6`, `top_p 0.95`, `top_k 20`, `stop` (with copy admitting they are not applied).
2. Send one chat message with `qwen3-8k` and inspect the request with the `interactions` query from issue 2 (or the LLM proxy logs UI).
3. Observed (verified): the full parameter payload was `{"model": "qwen3-8k:latest", "stream": true, "max_tokens": 8192, "tool_choice": "auto"}` — no `temperature`, no `num_ctx`, no `top_p`, no `top_k`, no `stop`. Only the (wrong, see issue 2) max output tokens.

**Proves the bug:** every parameter shown in the model dialog is absent from the actual request payload.

---

## Cleanup

```bash
ollama rm qwen3-8k qwen3:4b   # free ~2.6 GB
brew uninstall ollama          # if no longer needed
```
