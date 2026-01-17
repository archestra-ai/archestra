CREATE TABLE "processed_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" varchar(512) NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "processed_email_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE INDEX "processed_email_processed_at_idx" ON "processed_email" USING btree ("processed_at");