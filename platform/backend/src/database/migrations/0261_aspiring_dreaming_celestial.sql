UPDATE "conversations" SET "last_message_at" = "updated_at";
ALTER TABLE "conversations" ALTER COLUMN "last_message_at" SET NOT NULL;
