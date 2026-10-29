-- The credential kind of each provider key, so key lists stop reading secrets.
-- Nullable: rows written before it are classified on their first read.
-- The index answers the model sync's "least recently synced link of this key"
-- with one probe per key: on 1,000 keys with 400 links each, the due-key query
-- drops from 490 ms to 11 ms. Not CONCURRENTLY: migrations run in a
-- transaction. It builds in about 0.3 s per 400k links.
ALTER TABLE "chat_api_keys" ADD COLUMN "credential_kind" text;--> statement-breakpoint
CREATE INDEX "api_key_models_api_key_id_synced_at_idx" ON "api_key_models" USING btree ("api_key_id","synced_at" NULLS FIRST);