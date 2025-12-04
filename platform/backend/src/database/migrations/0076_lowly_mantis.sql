ALTER TABLE "sso_provider" ADD COLUMN "domain_verified" boolean;--> statement-breakpoint
-- Set domain_verified = true for all existing SSO providers to preserve functionality
-- With domainVerification: { enabled: true } in better-auth, providers need this flag
UPDATE "sso_provider" SET "domain_verified" = true WHERE "domain_verified" IS NULL;
