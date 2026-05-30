ALTER TABLE "conversations" ADD COLUMN "last_message_at" timestamp DEFAULT now() NOT NULL;
UPDATE "conversations" SET "last_message_at" = "updated_at";
