---
name: resolve-conflicts
description: Resolve merge conflicts in this repo — Drizzle migration number collisions (meta/_journal.json, meta/<NNNN>_snapshot.json), and related generated files like shared/hey-api/**/sdk.gen.ts. Use when git reports a merge conflict in any of these files, or when `drizzle-kit check` fails after a merge.
---

# Resolving Migration Merge Conflicts (migration number collision)
# When main has landed migrations that collide with your branch's migration number
# (conflicts in meta/_journal.json and meta/<NNNN>_snapshot.json), renumber YOUR
# migration to come AFTER main's. Never edit main's migrations. Steps:
#   1. Take main's side for the journal and colliding snapshot:
#        git checkout --theirs -- backend/src/database/migrations/meta/_journal.json \
#          backend/src/database/migrations/meta/<NNNN>_snapshot.json
#        git add the same two files
#      (Resolve any conflict in generated files like shared/hey-api/.../sdk.gen.ts
#       enough to parse — they get regenerated below.)
#   2. Renumber your migration SQL to the next free number, preserving history:
#        git mv backend/src/database/migrations/<OLD>_<name>.sql \
#               backend/src/database/migrations/<NEW>_<name>.sql
#   3. Regenerate the snapshot + journal entry: `cd backend && pnpm db:generate`
#      This emits a fresh <NEW>_<random>.sql, meta/<NEW>_snapshot.json, and a
#      journal entry tagged <NEW>_<random>.
#   4. Delete the generated <NEW>_<random>.sql (its ALTER statements are identical
#      to your file's schema portion) and KEEP your hand-written <NEW>_<name>.sql.
#      IMPORTANT: keep any data-migration logic (DO $$ blocks, UPDATE/INSERT) from
#      your original file — db:generate only emits schema DDL, not data migration.
#   5. Rename the journal tag <NEW>_<random> -> <NEW>_<name> to match your file.
#   6. Verify: `cd backend && npx drizzle-kit check` must print "Everything's fine".
#   7. Regenerate any conflicted generated clients from the merged spec, e.g.
#        cd shared && CODEGEN=true pnpm codegen:api-client
