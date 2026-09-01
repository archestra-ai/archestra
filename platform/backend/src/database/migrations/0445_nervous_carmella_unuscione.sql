-- Every FK below is added NOT VALID and validated in a separate statement. The
-- columns are new on this migration, so every existing row is NULL and the
-- validation cannot fail; splitting it keeps the validating scan off the lock
-- that ADD CONSTRAINT would otherwise hold against writes.
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD CONSTRAINT "knowledge_base_connectors_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" VALIDATE CONSTRAINT "knowledge_base_connectors_created_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "knowledge_bases" VALIDATE CONSTRAINT "knowledge_bases_created_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "chat_api_keys" ADD CONSTRAINT "chat_api_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "chat_api_keys" VALIDATE CONSTRAINT "chat_api_keys_created_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "service_accounts" VALIDATE CONSTRAINT "service_accounts_created_by_user_id_fk";--> statement-breakpoint
-- Backfill the only creator this change can recover honestly. A `personal`-scoped
-- provider key's `user_id` is stamped from the acting user at create time and
-- re-stamped whenever the key is rescoped to personal, so on those rows it names
-- the creator and not merely the audience.
--
-- `org`- and `team`-scoped rows are deliberately left NULL: their `user_id` is
-- null by construction, and there is nothing else on the row that knows who
-- added them. The same goes for every other table this migration touches —
-- guessing an owner would be worse than admitting the row predates the column,
-- because a wrong name in a "who do I contact" column gets believed.
UPDATE "chat_api_keys"
   SET "created_by" = "user_id"
 WHERE "scope" = 'personal'
   AND "user_id" IS NOT NULL
   AND "created_by" IS NULL;
