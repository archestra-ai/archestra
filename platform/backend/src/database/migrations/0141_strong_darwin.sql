ALTER TABLE "interactions" ADD COLUMN "execution_id" varchar;--> statement-breakpoint
CREATE INDEX "interactions_execution_id_idx" ON "interactions" USING btree ("execution_id");
