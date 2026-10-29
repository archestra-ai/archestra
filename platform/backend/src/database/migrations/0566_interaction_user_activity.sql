-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Validated foreign keys apply only to empty derived tables created here; user deletion intentionally cascades derived state.
CREATE TABLE "interaction_user_activity_deltas" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"generation" bigint NOT NULL,
	"balance" bigint NOT NULL,
	CONSTRAINT "interaction_user_activity_deltas_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "interaction_user_activity_missing_owners" (
	"kind" text NOT NULL,
	"owner_id" text NOT NULL,
	CONSTRAINT "interaction_user_activity_missing_owners_kind_owner_id_pk" PRIMARY KEY("kind","owner_id")
);
--> statement-breakpoint
CREATE TABLE "interaction_user_activity_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "interaction_user_activity_singleton" CHECK ("interaction_user_activity_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "interaction_user_activity" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"activity_count" bigint NOT NULL,
	CONSTRAINT "interaction_user_activity_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id"),
	CONSTRAINT "interaction_user_activity_positive" CHECK ("interaction_user_activity"."activity_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "interaction_user_activity_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "interaction_user_activity_deltas" ADD CONSTRAINT "interaction_user_activity_deltas_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_user_activity" ADD CONSTRAINT "interaction_user_activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_user_activity_users" ADD CONSTRAINT "interaction_user_activity_users_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "interaction_user_activity_state" ("id") VALUES (1);
--> statement-breakpoint
CREATE FUNCTION interaction_user_activity_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE interaction_user_activity_state SET generation=generation+1, revision=revision+1, ready=false WHERE id=1;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION interaction_user_activity_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE interaction_user_activity_state SET revision=revision+1 WHERE id=1;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION interaction_user_activity_owner_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM interaction_user_activity_missing_owners WHERE kind=TG_ARGV[0] AND owner_id=NEW.id::text) THEN
    UPDATE interaction_user_activity_state SET generation=generation+1, ready=false WHERE id=1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER interaction_user_activity_agents_changed BEFORE DELETE OR UPDATE OF id, organization_id ON agents FOR EACH STATEMENT EXECUTE FUNCTION interaction_user_activity_invalidate();
--> statement-breakpoint
CREATE TRIGGER interaction_user_activity_apps_changed BEFORE DELETE OR UPDATE OF id, organization_id ON apps FOR EACH STATEMENT EXECUTE FUNCTION interaction_user_activity_invalidate();
--> statement-breakpoint
CREATE TRIGGER interaction_user_activity_connectors_changed BEFORE DELETE OR UPDATE OF id, organization_id ON knowledge_base_connectors FOR EACH STATEMENT EXECUTE FUNCTION interaction_user_activity_invalidate();
--> statement-breakpoint
CREATE TRIGGER interaction_user_activity_apps_creating BEFORE INSERT ON apps FOR EACH STATEMENT EXECUTE FUNCTION interaction_user_activity_revision();
--> statement-breakpoint
CREATE TRIGGER interaction_user_activity_connectors_creating BEFORE INSERT ON knowledge_base_connectors FOR EACH STATEMENT EXECUTE FUNCTION interaction_user_activity_revision();
--> statement-breakpoint
CREATE TRIGGER interaction_user_activity_apps_created AFTER INSERT ON apps FOR EACH ROW EXECUTE FUNCTION interaction_user_activity_owner_created('app');
--> statement-breakpoint
CREATE TRIGGER interaction_user_activity_connectors_created AFTER INSERT ON knowledge_base_connectors FOR EACH ROW EXECUTE FUNCTION interaction_user_activity_owner_created('connector');
--> statement-breakpoint
CREATE TRIGGER interaction_user_activity_user_deleted BEFORE DELETE ON "user" FOR EACH STATEMENT EXECUTE FUNCTION interaction_user_activity_revision();
--> statement-breakpoint
CREATE TRIGGER interaction_user_activity_organization_deleted BEFORE DELETE OR UPDATE OF id ON organization FOR EACH STATEMENT EXECUTE FUNCTION interaction_user_activity_invalidate();

--> statement-breakpoint
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
BEGIN
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Interaction payload must be an object';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(payload) field
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = 'interactions'::regclass
      AND attribute.attname = field.key AND attribute.attnum > 0 AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL OR attribute.attgenerated <> '' OR attribute.attidentity <> ''
      OR jsonb_typeof(field.value) NOT IN ('string', 'null')
  ) THEN
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
