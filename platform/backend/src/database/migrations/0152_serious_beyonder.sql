DROP TABLE "token_price" CASCADE;--> statement-breakpoint
-- Rename RBAC resource "tokenPrice" to "llmModels" in custom role permissions
UPDATE "organization_role"
SET "permission" = REPLACE("permission", '"tokenPrice"', '"llmModels"')
WHERE "permission" LIKE '%tokenPrice%';