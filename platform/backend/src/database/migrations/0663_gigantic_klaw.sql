ALTER TABLE "organization" ADD COLUMN "departing_member_owner_id" text;
--> statement-breakpoint
-- FK constraint: clear the setting when that user is deleted
ALTER TABLE "organization"
  ADD CONSTRAINT "organization_departing_member_owner_id_user_id_fk"
  FOREIGN KEY ("departing_member_owner_id") REFERENCES "user"("id") ON DELETE SET NULL NOT VALID;
--> statement-breakpoint
ALTER TABLE "organization" VALIDATE CONSTRAINT "organization_departing_member_owner_id_user_id_fk";
