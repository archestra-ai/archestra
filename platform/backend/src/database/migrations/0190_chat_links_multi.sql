ALTER TABLE "organization" ADD COLUMN "chat_links" jsonb;--> statement-breakpoint

UPDATE "organization"
SET "chat_links" = jsonb_build_array(
  jsonb_build_object(
    'label',
    LEFT(COALESCE(NULLIF(BTRIM("help_center_label"), ''), 'Help Center'), 25),
    'url',
    BTRIM("help_center_url")
  )
)
WHERE "help_center_url" IS NOT NULL
  AND BTRIM("help_center_url") <> '';--> statement-breakpoint

ALTER TABLE "organization" DROP COLUMN "help_center_url";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "help_center_label";
