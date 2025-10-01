CREATE TABLE "tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tools_definition_idx" ON "tools" USING btree ("definition");