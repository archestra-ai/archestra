ALTER TABLE "agents" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;
UPDATE "agents" SET "is_default" = true WHERE "name" = 'Default Agent with Archestra';
