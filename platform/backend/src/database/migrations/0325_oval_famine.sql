-- Covering index so the cost-statistics aggregations run as index-only scans
-- instead of fetching heap pages dominated by large TOASTed JSONB payloads.
-- Not CONCURRENTLY: migrations run in a transaction and the table has few rows
-- (index builds in well under a second); only writers are briefly blocked.
CREATE INDEX "interactions_statistics_covering_idx" ON "interactions" USING btree ("created_at","profile_id","model","input_tokens","output_tokens","cache_read_tokens","cost","baseline_cost","toon_cost_savings","cache_savings");
