CREATE INDEX "openappa_host_keys_root_idx" ON "openappa_host_keys" USING btree ("root");--> statement-breakpoint
CREATE INDEX "openappa_offer_owners_session_idx" ON "openappa_offer_owners" USING btree ("organization_id","session_id","caller_id");--> statement-breakpoint
CREATE INDEX "openappa_offer_owners_root_idx" ON "openappa_offer_owners" USING btree ("root");--> statement-breakpoint
CREATE INDEX "openappa_offer_owners_created_at_idx" ON "openappa_offer_owners" USING btree ("created_at");