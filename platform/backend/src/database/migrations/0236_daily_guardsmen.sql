ALTER TABLE "limits" ALTER COLUMN "cleanup_interval" SET DEFAULT '1w';--> statement-breakpoint
ALTER TABLE "limits" ALTER COLUMN "cleanup_interval" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN "limit_cleanup_interval";