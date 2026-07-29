-- A proxy request naming a Claude context variant (`…-v1:0[1m]`) used to create
-- its own model row, because the bracketed id matched nothing the sync had
-- written. The marker is now stripped before the model is recorded, so no new
-- rows appear; these are the ones already written. Sync never reaches them --
-- no provider returns that id -- and `deleteOrphanedModels` deliberately spares
-- proxy-discovered rows, so each keeps the default $50/M estimate and a null
-- context window for as long as it exists.
--
-- Copying the canonical row's synced values onto them is preferred to deleting
-- them: `agents.model_id`, `member.default_model_id`,
-- `organization.default_model_id` and `conversations.model_id` are all
-- ON DELETE SET NULL, so removing a row someone had selected would silently
-- clear that selection. An update touches no reference.
--
-- Rows carrying a custom price are updated too, and that override still wins:
-- effective pricing reads the custom columns ahead of the synced ones, so this
-- only corrects what the row falls back to.
--
-- `discovered_via_llm_proxy` is left true. It records how the row came to
-- exist, which remains accurate, and clearing it would expose the row to
-- `deleteOrphanedModels` -- the deletion this migration exists to avoid.
UPDATE "models" AS stale
SET "prompt_price_per_token" = canonical."prompt_price_per_token",
    "completion_price_per_token" = canonical."completion_price_per_token",
    "cache_read_price_per_token" = canonical."cache_read_price_per_token",
    "cache_write_price_per_token" = canonical."cache_write_price_per_token",
    "context_length" = canonical."context_length",
    "output_length" = canonical."output_length",
    "input_modalities" = canonical."input_modalities",
    "output_modalities" = canonical."output_modalities",
    "supports_tool_calling" = canonical."supports_tool_calling",
    "description" = canonical."description",
    "last_synced_at" = now()
FROM "models" AS canonical
WHERE stale."discovered_via_llm_proxy" = true
  AND stale."model_id" ~* 'claude'
  AND stale."model_id" ~ '\[[0-9]+[kKmM]\]$'
  AND canonical."discovered_via_llm_proxy" = false
  AND canonical."provider" = stale."provider"
  AND canonical."model_id" = regexp_replace(stale."model_id", '\[[0-9]+[kKmM]\]$', '');
