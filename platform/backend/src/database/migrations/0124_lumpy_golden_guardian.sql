-- Removed: unique index not required and causes issues with existing duplicate data
-- CREATE UNIQUE INDEX "agents_organization_id_name_idx" ON "agents" USING btree ("organization_id","name");
SELECT 1;