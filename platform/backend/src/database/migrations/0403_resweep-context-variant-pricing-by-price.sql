-- Gives a Claude row named with a bracketed context-variant marker
-- (`claude-opus-4-7[1m]`) the price of the model it names, which 0371 and 0402
-- were meant to do but left on the flat fallback estimate.
--
-- Those passes identified the model by `discovered_via_llm_proxy = false`,
-- reading the column as "came from a real catalog". It does not mean that: it
-- records only that the LLM proxy was the first thing to name the id, and
-- nothing clears it afterwards, so a model the proxy saw before a key had
-- synced it stays marked even once a catalog prices it. `claude-opus-4-7` and
-- `claude-opus-4-8` are both in that state, so their marked rows matched no row
-- to copy from.
--
-- A non-null synced price asks the question that actually matters -- does this
-- row have a real price to copy? -- and holds however either row was created.
UPDATE "models" AS stale
SET "prompt_price_per_token" = canonical."prompt_price_per_token",
    "completion_price_per_token" = canonical."completion_price_per_token",
    "cache_read_price_per_token" = canonical."cache_read_price_per_token",
    "cache_write_price_per_token" = canonical."cache_write_price_per_token",
    "context_length" = canonical."context_length",
    "output_length" = canonical."output_length",
    "supports_tool_calling" = canonical."supports_tool_calling",
    "description" = canonical."description",
    "last_synced_at" = now()
FROM "models" AS canonical
WHERE stale."discovered_via_llm_proxy" = true
  -- Only rows still on the fallback estimate, which is computed at read time
  -- and never stored. Keeps this re-runnable: a row an earlier pass fixed, or
  -- one since priced by hand, no longer matches.
  AND stale."prompt_price_per_token" IS NULL
  AND stale."model_id" ~* 'claude'
  AND stale."model_id" ~ '\[[0-9]+[kKmM]\]$'
  AND canonical."prompt_price_per_token" IS NOT NULL
  AND canonical."provider" = stale."provider"
  AND canonical."model_id" = regexp_replace(stale."model_id", '\[[0-9]+[kKmM]\]$', '');
