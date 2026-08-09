-- Re-sweep of 0371_backfill-stale-context-variant-proxy-models.sql.
--
-- That migration copied a canonical Claude row's synced values onto any
-- proxy-discovered row whose id was the same model plus a bracketed
-- context-variant marker (`claude-opus-4-8[1m]`), so the marked row would
-- price and describe itself the same as the model it names. It could only
-- match a canonical row that existed at the time it ran. A marked row whose
-- canonical model wasn't synced yet -- e.g. a Claude model released after
-- that migration -- stayed at the default $50/M estimate with a null context
-- window, because nothing revisits a proxy-discovered row after its first
-- sighting: enrichment runs once, at creation, and sync never touches
-- proxy-discovered rows.
--
-- This is the same UPDATE, restricted to rows still holding the null price
-- that marks an unenriched row (the default $50/M estimate is computed at
-- read time, never stored). That scoping, absent from the first pass, is
-- what makes re-running this safe: a row the first pass already fixed --
-- or a row someone has since priced by hand -- no longer matches, so this
-- can be re-run again later the same way without re-touching it.
--
-- input_modalities/output_modalities are dropped from the copy for the same
-- reason. Unlike price, which has customPricePerMillion* columns the read
-- path checks ahead of the synced ones, modalities have no such override:
-- PatchModelBodySchema (models/model.ts, ModelModel.update) writes straight
-- to these two columns from the edit dialog. Copying them here would revert
-- a correction someone made through it. Every other synced column this
-- targets is not on that admin-editable surface.
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
  AND stale."prompt_price_per_token" IS NULL
  AND stale."model_id" ~* 'claude'
  AND stale."model_id" ~ '\[[0-9]+[kKmM]\]$'
  AND canonical."discovered_via_llm_proxy" = false
  AND canonical."provider" = stale."provider"
  AND canonical."model_id" = regexp_replace(stale."model_id", '\[[0-9]+[kKmM]\]$', '');
