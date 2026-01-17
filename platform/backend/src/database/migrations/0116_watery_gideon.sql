CREATE INDEX "interactions_request_gin_idx" ON "interactions" USING gin ("request");--> statement-breakpoint
CREATE INDEX "interactions_response_gin_idx" ON "interactions" USING gin ("response");