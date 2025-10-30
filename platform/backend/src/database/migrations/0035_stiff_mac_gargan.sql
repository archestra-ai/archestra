ALTER TABLE "interactions" ADD COLUMN "provider" varchar(50);--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "model" varchar(100);--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "interactions" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
CREATE INDEX "interactions_provider_idx" ON "interactions" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "interactions_model_idx" ON "interactions" USING btree ("model");