-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=chat_api_keys.billing_mode landed on main after the last tagged release (v1.3.10) and is dropped before the next one, so no released version reads it; billing mode is now inferred from the credential format instead of per-key configuration. Only skew window is a rolling dev/staging deploy.
ALTER TABLE "chat_api_keys" DROP COLUMN "billing_mode";
