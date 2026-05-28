ALTER TABLE "limits" ADD COLUMN "cleanup_interval" varchar DEFAULT '1w' NOT NULL;--> statement-breakpoint
UPDATE "limits"
SET "cleanup_interval" = COALESCE(
  CASE
    WHEN "limits"."entity_type" = 'organization' THEN (
      SELECT "organization"."limit_cleanup_interval"
      FROM "organization"
      WHERE "organization"."id" = "limits"."entity_id"
    )
    WHEN "limits"."entity_type" = 'team' THEN (
      SELECT "organization"."limit_cleanup_interval"
      FROM "team"
      INNER JOIN "organization" ON "organization"."id" = "team"."organization_id"
      WHERE "team"."id" = "limits"."entity_id"
    )
    WHEN "limits"."entity_type" = 'agent' THEN (
      SELECT "organization"."limit_cleanup_interval"
      FROM "agents"
      INNER JOIN "organization" ON "organization"."id" = "agents"."organization_id"
      WHERE "agents"."id"::text = "limits"."entity_id"
    )
    WHEN "limits"."entity_type" = 'user' THEN (
      SELECT "organization"."limit_cleanup_interval"
      FROM "member"
      INNER JOIN "organization" ON "organization"."id" = "member"."organization_id"
      WHERE "member"."user_id" = "limits"."entity_id"
      LIMIT 1
    )
    WHEN "limits"."entity_type" = 'virtual_key' THEN (
      SELECT "organization"."limit_cleanup_interval"
      FROM "virtual_api_keys"
      INNER JOIN "organization" ON "organization"."id" = "virtual_api_keys"."organization_id"
      WHERE "virtual_api_keys"."id"::text = "limits"."entity_id"
    )
  END,
  '1w'
);--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_user_limit_value" integer;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_user_limit_model" jsonb;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_user_limit_cleanup_interval" varchar;--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "limit_cleanup_interval";
