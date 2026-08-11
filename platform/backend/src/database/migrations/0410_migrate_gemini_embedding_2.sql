-- Gemini Embedding 2 left preview and the preview endpoint was retired. Move
-- active knowledge configurations and model-key links to the stable id while
-- preserving the dimensions selected for the existing vector index.
DO $$
DECLARE
  preview_model_id uuid;
  stable_model_id uuid;
  dimensions_compatible boolean := true;
  stable_model_in_use boolean := false;
  stable_was_image_capable boolean := true;
BEGIN
  SELECT id INTO preview_model_id
  FROM models
  WHERE provider = 'gemini' AND model_id = 'gemini-embedding-2-preview';

  SELECT id INTO stable_model_id
  FROM models
  WHERE provider = 'gemini' AND model_id = 'gemini-embedding-2';

  IF stable_model_id IS NOT NULL THEN
    SELECT COALESCE(input_modalities @> '["image"]'::jsonb, false)
    INTO stable_was_image_capable
    FROM models
    WHERE id = stable_model_id;
  END IF;

  IF preview_model_id IS NOT NULL AND stable_model_id IS NULL THEN
    UPDATE models
    SET model_id = 'gemini-embedding-2',
        external_id = replace(external_id, 'gemini-embedding-2-preview', 'gemini-embedding-2'),
        description = replace(description, ' Preview', ''),
        input_modalities = '["text", "image"]'::jsonb,
        output_modalities = '[]'::jsonb,
        supports_tool_calling = false,
        updated_at = now()
    WHERE id = preview_model_id;
    stable_model_id := preview_model_id;
  ELSIF preview_model_id IS NOT NULL AND stable_model_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM "organization" organization
      INNER JOIN "chat_api_keys" api_key
        ON api_key.id = organization.embedding_chat_api_key_id
      WHERE api_key.provider = 'gemini'
        AND organization.embedding_model = 'gemini-embedding-2'
    ) INTO stable_model_in_use;

    -- A model row's dimension is the shape of every vector already stored for
    -- organizations using it. Prefer the preview row only when the stable row
    -- is not live; mutating an active stable row would corrupt its vector index.
    IF NOT stable_model_in_use THEN
      UPDATE models stable
      SET embedding_dimensions = COALESCE(preview.embedding_dimensions, stable.embedding_dimensions)
      FROM models preview
      WHERE stable.id = stable_model_id AND preview.id = preview_model_id;
    END IF;

    SELECT preview.embedding_dimensions IS NOT DISTINCT FROM stable.embedding_dimensions
    INTO dimensions_compatible
    FROM models preview, models stable
    WHERE preview.id = preview_model_id AND stable.id = stable_model_id;

    UPDATE models stable
    SET input_modalities = '["text", "image"]'::jsonb,
        output_modalities = '[]'::jsonb,
        supports_tool_calling = false,
        updated_at = now()
    WHERE stable.id = stable_model_id;

    INSERT INTO api_key_models (api_key_id, model_id, is_best, recommended_for_agents)
    SELECT link.api_key_id, stable_model_id, link.is_best, link.recommended_for_agents
    FROM api_key_models link
    INNER JOIN chat_api_keys api_key ON api_key.id = link.api_key_id
    WHERE link.model_id = preview_model_id AND api_key.provider = 'gemini'
    ON CONFLICT (api_key_id, model_id) DO NOTHING;
  END IF;

  IF stable_model_id IS NOT NULL THEN
    UPDATE models
    SET input_modalities = '["text", "image"]'::jsonb,
        output_modalities = '[]'::jsonb,
        supports_tool_calling = false,
        updated_at = now()
    WHERE id = stable_model_id;
  END IF;

  -- Stable rows discovered before this release were text-only. Expanding an
  -- active row to image-capable bypasses the API's drop/re-embed guard, so
  -- rewind affected connector checkpoints and let their next sync backfill
  -- images that an earlier incremental pass deliberately skipped.
  IF stable_model_id IS NOT NULL AND NOT stable_was_image_capable THEN
    UPDATE knowledge_base_connectors connector
    SET checkpoint = NULL, updated_at = now()
    WHERE connector.deleted_at IS NULL
      AND connector.organization_id IN (
        SELECT organization.id
        FROM "organization" organization
        INNER JOIN chat_api_keys api_key
          ON api_key.id = organization.embedding_chat_api_key_id
        WHERE api_key.provider = 'gemini'
          AND organization.embedding_model = 'gemini-embedding-2'
      );
  END IF;

  -- Provider is part of the embedding identity. Never rename an OpenRouter or
  -- custom-provider model that happens to use the same model-id string. When
  -- two live Gemini rows have incompatible dimensions, leave preview configs
  -- untouched rather than silently pointing their existing vectors at a model
  -- with a different shape; an administrator can then drop/reconfigure them.
  IF dimensions_compatible THEN
    UPDATE "organization" organization
    SET embedding_model = 'gemini-embedding-2'
    FROM "chat_api_keys" api_key
    WHERE organization.embedding_chat_api_key_id = api_key.id
      AND api_key.provider = 'gemini'
      AND organization.embedding_model = 'gemini-embedding-2-preview';

    DELETE FROM api_key_models link
    USING chat_api_keys api_key
    WHERE link.api_key_id = api_key.id
      AND api_key.provider = 'gemini'
      AND link.model_id = preview_model_id
      AND preview_model_id <> stable_model_id;
  ELSE
    RAISE WARNING 'Gemini embedding preview configurations were not migrated because stable and preview dimensions differ';
  END IF;
END $$;
