-- Btree index backing name-ordered member pages (the user limits roster lists
-- members without spend alphabetically after everyone with spend).
--
-- Without it, every page sorted the whole roster under the database collation:
-- ~750ms for 65k users, even with LIMIT. The trigram index (0378) serves
-- substring search only and cannot return rows in name order.
--
-- "user" is a small, low-write table, so a plain (non-concurrent) build is
-- brief.
CREATE INDEX IF NOT EXISTS "user_name_idx" ON "user" USING btree (name, id);
