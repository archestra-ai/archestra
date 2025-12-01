ALTER TABLE "secret" ALTER COLUMN "name" SET DATA TYPE varchar(256);--> statement-breakpoint
ALTER TABLE "secret" ALTER COLUMN "name" SET DEFAULT 'secret';