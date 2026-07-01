ALTER TABLE "environments" ADD COLUMN "network_policy" jsonb;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_network_policy" jsonb;--> statement-breakpoint
UPDATE "environments"
SET "network_policy" = jsonb_build_object(
  'egressMode', "network_policies"."egress_mode",
  'domainPreset', "network_policies"."domain_preset",
  'allowedDomains', "network_policies"."allowed_domains",
  'allowedCidrs', "network_policies"."allowed_cidrs"
)
FROM "network_policies"
WHERE "environments"."network_policy_id" = "network_policies"."id";--> statement-breakpoint
UPDATE "organization"
SET "default_network_policy" = jsonb_build_object(
  'egressMode', "network_policies"."egress_mode",
  'domainPreset', "network_policies"."domain_preset",
  'allowedDomains', "network_policies"."allowed_domains",
  'allowedCidrs', "network_policies"."allowed_cidrs"
)
FROM "network_policies"
WHERE "organization"."default_network_policy_id" = "network_policies"."id";--> statement-breakpoint
ALTER TABLE "environments" DROP CONSTRAINT "environments_network_policy_id_network_policies_id_fk";
--> statement-breakpoint
ALTER TABLE "organization" DROP CONSTRAINT "organization_default_network_policy_id_network_policies_id_fk";
--> statement-breakpoint
DROP INDEX "environments_network_policy_id_idx";--> statement-breakpoint
ALTER TABLE "environments" DROP COLUMN "network_policy_id";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "default_network_policy_id";--> statement-breakpoint
ALTER TABLE "network_policies" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "network_policies" CASCADE;
