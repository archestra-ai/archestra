-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=every flagged FOREIGN KEY and non-concurrent index targets a table created empty in this same file (kb_directories, kb_directory_team, kb_files, kb_file_team, kb_file_document, kb_upload_connector), so each constraint validates against zero rows and each index builds instantly; the pre-existing tables referenced (team, user, kb_documents, knowledge_bases, knowledge_base_connectors) are only read for the FK check.
CREATE TABLE "kb_directories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"visibility" text DEFAULT 'org-wide' NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_directory_team" (
	"directory_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	CONSTRAINT "kb_directory_team_directory_id_team_id_pk" PRIMARY KEY("directory_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "kb_file_document" (
	"kb_file_id" uuid NOT NULL,
	"kb_document_id" uuid NOT NULL,
	CONSTRAINT "kb_file_document_kb_file_id_kb_document_id_pk" PRIMARY KEY("kb_file_id","kb_document_id")
);
--> statement-breakpoint
CREATE TABLE "kb_file_team" (
	"kb_file_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	CONSTRAINT "kb_file_team_kb_file_id_team_id_pk" PRIMARY KEY("kb_file_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "kb_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"directory_id" uuid,
	"visibility" text DEFAULT 'org-wide' NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_provider" text DEFAULT 'db' NOT NULL,
	"data" "bytea",
	"object_key" text,
	"uploaded_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "kb_files_storage_payload_chk" CHECK ((
        ("kb_files"."storage_provider" =  'db' AND "kb_files"."data" IS NOT NULL AND "kb_files"."object_key" IS NULL)
        OR ("kb_files"."storage_provider" <> 'db' AND "kb_files"."object_key" IS NOT NULL AND "kb_files"."data" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "kb_upload_connector" (
	"knowledge_base_id" uuid PRIMARY KEY NOT NULL,
	"connector_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_directories" ADD CONSTRAINT "kb_directories_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_directory_team" ADD CONSTRAINT "kb_directory_team_directory_id_kb_directories_id_fk" FOREIGN KEY ("directory_id") REFERENCES "public"."kb_directories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_file_document" ADD CONSTRAINT "kb_file_document_kb_file_id_kb_files_id_fk" FOREIGN KEY ("kb_file_id") REFERENCES "public"."kb_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_file_document" ADD CONSTRAINT "kb_file_document_kb_document_id_kb_documents_id_fk" FOREIGN KEY ("kb_document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_file_team" ADD CONSTRAINT "kb_file_team_kb_file_id_kb_files_id_fk" FOREIGN KEY ("kb_file_id") REFERENCES "public"."kb_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_files" ADD CONSTRAINT "kb_files_directory_id_kb_directories_id_fk" FOREIGN KEY ("directory_id") REFERENCES "public"."kb_directories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_files" ADD CONSTRAINT "kb_files_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_upload_connector" ADD CONSTRAINT "kb_upload_connector_knowledge_base_id_knowledge_bases_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_upload_connector" ADD CONSTRAINT "kb_upload_connector_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_directories_organization_id_idx" ON "kb_directories" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_directories_org_name_uidx" ON "kb_directories" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "kb_directory_team_team_idx" ON "kb_directory_team" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "kb_file_document_document_idx" ON "kb_file_document" USING btree ("kb_document_id");--> statement-breakpoint
CREATE INDEX "kb_file_team_team_idx" ON "kb_file_team" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "kb_files_organization_id_idx" ON "kb_files" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "kb_files_directory_id_idx" ON "kb_files" USING btree ("directory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_files_org_directory_filename_uidx" ON "kb_files" USING btree ("organization_id","directory_id","filename") WHERE "kb_files"."directory_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_files_org_root_filename_uidx" ON "kb_files" USING btree ("organization_id","filename") WHERE "kb_files"."directory_id" IS NULL;