ALTER TABLE "tools" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb;
ALTER TABLE "tools" ADD COLUMN "annotations" jsonb DEFAULT '{}'::jsonb;
