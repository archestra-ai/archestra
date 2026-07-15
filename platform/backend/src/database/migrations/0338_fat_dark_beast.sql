-- Index for the per-project conversation aggregations on the projects views;
-- project_id has an FK but no index, so those counts seq-scan conversations.
-- Not CONCURRENTLY: migrations run in a transaction and conversations is a
-- modest table (one row per chat); the build blocks writers only briefly.
CREATE INDEX "conversations_project_id_idx" ON "conversations" USING btree ("project_id");
