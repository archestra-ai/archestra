-- Cache insert plans for common proxy records. Other payload shapes retain
-- dynamic column/type handling, including defaults for omitted columns.
CREATE OR REPLACE FUNCTION interaction_user_activity_append(payload jsonb) RETURNS SETOF interactions LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  fence interaction_user_activity_state%ROWTYPE;
  checkpoint_generation bigint;
  owner_org text;
  incoming interactions%ROWTYPE;
  inserted interactions%ROWTYPE;
  column_names text;
  column_values text;
  inserted_rows bigint;
  invalid_payload boolean;
  payload_columns text[];
  json_types_match boolean;
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Interaction payload must be an object';
  END IF;
  SELECT bool_or(attribute.attname IS NULL OR attribute.attgenerated <> '' OR attribute.attidentity <> ''
      OR jsonb_typeof(field.value) NOT IN ('string', 'null')),
    array_agg(field.key ORDER BY field.key COLLATE "C")
      FILTER (WHERE field.key NOT IN ('virtual_key_id', 'passthrough_virtual_key_id')),
    bool_and(field.key NOT IN ('request', 'response', 'processed_request', 'session_preview', 'attribution_labels') OR attribute.atttypid = 'jsonb'::regtype)
    INTO invalid_payload, payload_columns, json_types_match
    FROM jsonb_each(payload) field
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = 'interactions'::regclass
      AND attribute.attname = field.key AND attribute.attnum > 0 AND NOT attribute.attisdropped;
  IF invalid_payload THEN
    RAISE EXCEPTION 'Unsupported interaction payload column or encoding';
  END IF;
  incoming.id := (payload->>'id')::uuid;
  incoming.user_id := payload->>'user_id';
  incoming.profile_id := (payload->>'profile_id')::uuid;
  incoming.app_id := (payload->>'app_id')::uuid;
  incoming.connector_id := (payload->>'connector_id')::uuid;
  IF incoming.id IS NULL THEN
    RAISE EXCEPTION 'Interaction append requires a stable id';
  END IF;
  SELECT * INTO fence FROM interaction_user_activity_state WHERE id=1 FOR SHARE;
  IF NOT FOUND THEN
    INSERT INTO interaction_user_activity_state(id) VALUES(1) ON CONFLICT DO NOTHING;
    SELECT * INTO STRICT fence FROM interaction_user_activity_state WHERE id=1 FOR SHARE;
  END IF;
  IF fence.enabled AND incoming.user_id IS NOT NULL THEN
    INSERT INTO interaction_user_activity_users(user_id,generation)
      VALUES(incoming.user_id,CASE WHEN fence.ready THEN fence.generation ELSE 0 END)
      ON CONFLICT DO NOTHING;
    SELECT generation INTO STRICT checkpoint_generation FROM interaction_user_activity_users
      WHERE user_id=incoming.user_id FOR UPDATE;
  END IF;
  -- Exact key matching leaves omitted-column defaults and uncommon shapes
  -- on the generic path. Populate native types from the current table type;
  -- cast JSON strings separately to preserve SQL NULL versus JSON null.
  IF json_types_match AND payload_columns = ARRAY[
      'attribution_labels', 'auth_method', 'baseline_cost', 'baseline_model',
      'billing_mode', 'cache_cost', 'cache_read_tokens', 'cache_savings',
      'cache_write_1h_tokens', 'cache_write_tokens', 'cost', 'duration_ms',
      'environment_id', 'id', 'input_tokens', 'input_tokens_estimated',
      'model', 'output_tokens', 'processed_request', 'profile_id',
      'request', 'response', 'session_id', 'session_preview',
      'session_source', 'source', 'type', 'user_id'
    ]::text[] THEN
    incoming := jsonb_populate_record(NULL::interactions,
      payload - ARRAY['request', 'response', 'processed_request', 'session_preview', 'attribution_labels']::text[]);
    IF payload ? 'virtual_key_id' AND payload ? 'passthrough_virtual_key_id' THEN
      INSERT INTO interactions (
        id, profile_id, request, response, type,
        input_tokens, output_tokens, model, baseline_cost, cost,
        processed_request, user_id, session_id, session_source, baseline_model,
        source, auth_method, cache_read_tokens, cache_write_tokens, cache_cost,
        cache_savings, cache_write_1h_tokens, environment_id, input_tokens_estimated, billing_mode,
        duration_ms, session_preview, attribution_labels, virtual_key_id, passthrough_virtual_key_id
      ) VALUES (
        incoming.id, incoming.profile_id, (payload->>'request')::jsonb,
        (payload->>'response')::jsonb, incoming.type, incoming.input_tokens,
        incoming.output_tokens, incoming.model, incoming.baseline_cost,
        incoming.cost, (payload->>'processed_request')::jsonb, incoming.user_id,
        incoming.session_id, incoming.session_source, incoming.baseline_model,
        incoming.source, incoming.auth_method, incoming.cache_read_tokens,
        incoming.cache_write_tokens, incoming.cache_cost, incoming.cache_savings,
        incoming.cache_write_1h_tokens, incoming.environment_id, incoming.input_tokens_estimated,
        incoming.billing_mode, incoming.duration_ms, (payload->>'session_preview')::jsonb,
        (payload->>'attribution_labels')::jsonb, incoming.virtual_key_id, incoming.passthrough_virtual_key_id
      ) ON CONFLICT(id) DO NOTHING RETURNING * INTO inserted;
    ELSIF payload ? 'virtual_key_id' THEN
      INSERT INTO interactions (
        id, profile_id, request, response, type,
        input_tokens, output_tokens, model, baseline_cost, cost,
        processed_request, user_id, session_id, session_source, baseline_model,
        source, auth_method, cache_read_tokens, cache_write_tokens, cache_cost,
        cache_savings, cache_write_1h_tokens, environment_id, input_tokens_estimated, billing_mode,
        duration_ms, session_preview, attribution_labels, virtual_key_id
      ) VALUES (
        incoming.id, incoming.profile_id, (payload->>'request')::jsonb,
        (payload->>'response')::jsonb, incoming.type, incoming.input_tokens,
        incoming.output_tokens, incoming.model, incoming.baseline_cost,
        incoming.cost, (payload->>'processed_request')::jsonb, incoming.user_id,
        incoming.session_id, incoming.session_source, incoming.baseline_model,
        incoming.source, incoming.auth_method, incoming.cache_read_tokens,
        incoming.cache_write_tokens, incoming.cache_cost, incoming.cache_savings,
        incoming.cache_write_1h_tokens, incoming.environment_id, incoming.input_tokens_estimated,
        incoming.billing_mode, incoming.duration_ms, (payload->>'session_preview')::jsonb,
        (payload->>'attribution_labels')::jsonb, incoming.virtual_key_id
      ) ON CONFLICT(id) DO NOTHING RETURNING * INTO inserted;
    ELSIF payload ? 'passthrough_virtual_key_id' THEN
      INSERT INTO interactions (
        id, profile_id, request, response, type,
        input_tokens, output_tokens, model, baseline_cost, cost,
        processed_request, user_id, session_id, session_source, baseline_model,
        source, auth_method, cache_read_tokens, cache_write_tokens, cache_cost,
        cache_savings, cache_write_1h_tokens, environment_id, input_tokens_estimated, billing_mode,
        duration_ms, session_preview, attribution_labels, passthrough_virtual_key_id
      ) VALUES (
        incoming.id, incoming.profile_id, (payload->>'request')::jsonb,
        (payload->>'response')::jsonb, incoming.type, incoming.input_tokens,
        incoming.output_tokens, incoming.model, incoming.baseline_cost,
        incoming.cost, (payload->>'processed_request')::jsonb, incoming.user_id,
        incoming.session_id, incoming.session_source, incoming.baseline_model,
        incoming.source, incoming.auth_method, incoming.cache_read_tokens,
        incoming.cache_write_tokens, incoming.cache_cost, incoming.cache_savings,
        incoming.cache_write_1h_tokens, incoming.environment_id, incoming.input_tokens_estimated,
        incoming.billing_mode, incoming.duration_ms, (payload->>'session_preview')::jsonb,
        (payload->>'attribution_labels')::jsonb, incoming.passthrough_virtual_key_id
      ) ON CONFLICT(id) DO NOTHING RETURNING * INTO inserted;
    ELSE
      INSERT INTO interactions (
        id, profile_id, request, response, type,
        input_tokens, output_tokens, model, baseline_cost, cost,
        processed_request, user_id, session_id, session_source, baseline_model,
        source, auth_method, cache_read_tokens, cache_write_tokens, cache_cost,
        cache_savings, cache_write_1h_tokens, environment_id, input_tokens_estimated, billing_mode,
        duration_ms, session_preview, attribution_labels
      ) VALUES (
        incoming.id, incoming.profile_id, (payload->>'request')::jsonb,
        (payload->>'response')::jsonb, incoming.type, incoming.input_tokens,
        incoming.output_tokens, incoming.model, incoming.baseline_cost,
        incoming.cost, (payload->>'processed_request')::jsonb, incoming.user_id,
        incoming.session_id, incoming.session_source, incoming.baseline_model,
        incoming.source, incoming.auth_method, incoming.cache_read_tokens,
        incoming.cache_write_tokens, incoming.cache_cost, incoming.cache_savings,
        incoming.cache_write_1h_tokens, incoming.environment_id, incoming.input_tokens_estimated,
        incoming.billing_mode, incoming.duration_ms, (payload->>'session_preview')::jsonb,
        (payload->>'attribution_labels')::jsonb
      ) ON CONFLICT(id) DO NOTHING RETURNING * INTO inserted;
    END IF;
  ELSE
    -- %L quotes values as SQL literals. Column validation above restricts types to
    -- trusted catalog attributes; format_type returns quoted SQL type syntax,
    -- including modifiers, so %s is intentional (%I would quote the whole syntax).
    SELECT string_agg(format('%I', attribute.attname), ',' ORDER BY attribute.attnum),
      string_agg(format('%L::%s', field.value, format_type(attribute.atttypid, attribute.atttypmod)), ',' ORDER BY attribute.attnum)
      INTO column_names, column_values
      FROM jsonb_each_text(payload) field
      JOIN pg_attribute attribute ON attribute.attrelid = 'interactions'::regclass
        AND attribute.attname = field.key AND attribute.attnum > 0 AND NOT attribute.attisdropped;
    EXECUTE format('INSERT INTO interactions (%s) VALUES (%s) ON CONFLICT(id) DO NOTHING RETURNING *', column_names, column_values)
      INTO inserted;
  END IF;
  GET DIAGNOSTICS inserted_rows = ROW_COUNT;
  IF inserted_rows = 0 THEN
    SELECT * INTO STRICT inserted FROM interactions WHERE id=incoming.id;
    IF inserted.user_id IS DISTINCT FROM incoming.user_id
      OR inserted.profile_id IS DISTINCT FROM incoming.profile_id
      OR inserted.app_id IS DISTINCT FROM incoming.app_id
      OR inserted.connector_id IS DISTINCT FROM incoming.connector_id THEN
      RAISE EXCEPTION 'Interaction id already used for different attribution';
    END IF;
    RETURN NEXT inserted;
    RETURN;
  END IF;
  IF fence.enabled AND inserted.user_id IS NOT NULL THEN
    IF inserted.app_id IS NOT NULL OR inserted.connector_id IS NOT NULL THEN
      INSERT INTO interaction_user_activity_missing_owners(kind,owner_id)
        SELECT 'app',inserted.app_id::text WHERE inserted.app_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM apps WHERE id=inserted.app_id)
        UNION SELECT 'connector',inserted.connector_id::text WHERE inserted.connector_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM knowledge_base_connectors WHERE id=inserted.connector_id)
        ON CONFLICT DO NOTHING;
    END IF;
    SELECT COALESCE(agent.organization_id,connector.organization_id,app.organization_id) INTO owner_org
      FROM (SELECT inserted.profile_id,inserted.app_id,inserted.connector_id) input
      LEFT JOIN agents agent ON agent.id=input.profile_id
      LEFT JOIN apps app ON app.id=input.app_id
      LEFT JOIN knowledge_base_connectors connector ON connector.id=input.connector_id
      WHERE COALESCE(agent.organization_id,connector.organization_id,app.organization_id) IS NOT NULL
        AND (input.profile_id IS NULL OR agent.organization_id=COALESCE(agent.organization_id,connector.organization_id,app.organization_id))
        AND (input.app_id IS NULL OR app.organization_id=COALESCE(agent.organization_id,connector.organization_id,app.organization_id))
        AND (input.connector_id IS NULL OR connector.organization_id=COALESCE(agent.organization_id,connector.organization_id,app.organization_id));
    IF owner_org IS NOT NULL THEN
      IF checkpoint_generation=fence.generation THEN
        INSERT INTO interaction_user_activity(organization_id,user_id,activity_count) VALUES(owner_org,inserted.user_id,1)
          ON CONFLICT(organization_id,user_id) DO UPDATE SET activity_count=interaction_user_activity.activity_count+1;
      END IF;
      INSERT INTO interaction_user_activity_deltas(organization_id,user_id,generation,balance) VALUES(owner_org,inserted.user_id,fence.generation,1)
        ON CONFLICT(organization_id,user_id) DO UPDATE SET generation=excluded.generation,
          balance=CASE WHEN interaction_user_activity_deltas.generation=excluded.generation THEN interaction_user_activity_deltas.balance+1 ELSE 1 END;
    END IF;
  END IF;
  RETURN NEXT inserted;
END;
$$;
