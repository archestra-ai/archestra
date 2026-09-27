-- Custom SQL migration file, put your code below! --
-- Permission sync is a connector capability. The knowledgeSource role actions
-- and per-connector grants now govern its management like any other connector.
-- Remove the retired permission resource from frozen custom-role snapshots so
-- roles remain valid against the current permission schema.
UPDATE "organization_role"
SET "permission" = ("permission"::jsonb - 'knowledgeSourceAutoSync')::text
WHERE COALESCE("permission", '') LIKE '%"knowledgeSourceAutoSync"%';
