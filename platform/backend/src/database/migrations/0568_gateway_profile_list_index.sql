-- The gateways and profiles list pages through those agents newest first. On
-- agents_org_created_at_live_idx it filtered every chat agent and, when few
-- rows matched, read to the end of the index before filling a page. This
-- index holds only live gateways and profiles, a small share of the table.
-- Not CONCURRENTLY: migrations run in a transaction. The agents table is
-- small and rarely written; the build takes well under a second at 133k rows.
CREATE INDEX "agents_org_gateway_profile_created_at_live_idx" ON "agents" USING btree ("organization_id","created_at","id") WHERE "agents"."deleted_at" IS NULL AND "agents"."agent_type" IN ('mcp_gateway', 'profile');