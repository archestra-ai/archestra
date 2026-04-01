ALTER TABLE "agents" ADD COLUMN "schedule_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "agents" ADD COLUMN "schedule" text;
ALTER TABLE "agents" ADD COLUMN "schedule_prompt" text;
ALTER TABLE "agents" ADD COLUMN "last_scheduled_at" timestamp;
CREATE INDEX "agents_schedule_enabled_idx" ON "agents" ("schedule_enabled");
