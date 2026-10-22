ALTER TABLE "agents" ADD COLUMN "fast_model_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "smart_model_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_fast_model_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "default_smart_model_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_fast_model_id_models_id_fk" FOREIGN KEY ("fast_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_fast_model_id_models_id_fk";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_smart_model_id_models_id_fk" FOREIGN KEY ("smart_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "agents" VALIDATE CONSTRAINT "agents_smart_model_id_models_id_fk";--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_default_fast_model_id_models_id_fk" FOREIGN KEY ("default_fast_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "organization" VALIDATE CONSTRAINT "organization_default_fast_model_id_models_id_fk";--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_default_smart_model_id_models_id_fk" FOREIGN KEY ("default_smart_model_id") REFERENCES "public"."models"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "organization" VALIDATE CONSTRAINT "organization_default_smart_model_id_models_id_fk";
