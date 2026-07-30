ALTER TABLE "conversations" ADD COLUMN "title_is_placeholder" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Mark existing app-opened chats whose title is still the seeded app name, so
-- they pick up a generated title on their next settled exchange like new ones.
--   1. No user message yet: `ConversationModel.findAll` hides `app_open` chats
--      from the sidebar until one exists, and that sidebar is the only rename UI
--      in the product, so an unlisted chat cannot have been renamed. This branch
--      is exact.
--   2. The title still equals the label captured in the seeded render message —
--      the very string that became the title, so this survives an app rename.
--      Owned apps carry it in `structuredContent.name`; external apps put it on
--      the first line of `content`. This branch cannot tell an untouched title
--      from one a user deliberately renamed to the app's own name; nothing
--      durable records that. Such a chat gets retitled once on its next
--      exchange, the accepted cost of reaching existing chats at all.
-- External prompt-mode chats that already have an exchange are deliberately
-- skipped: they seed no assistant message, so their label survives only inside
-- the opening prompt text, and parsing that sentence would be exactly the
-- guesswork this flag exists to replace. They keep "Regenerate title".
UPDATE "conversations" c
SET "title_is_placeholder" = true
WHERE c."origin" = 'app_open'
  AND c."title" IS NOT NULL
  AND (
    NOT EXISTS (
      SELECT 1 FROM "messages" m
      WHERE m."conversation_id" = c."id" AND m."role" = 'user'
    )
    OR EXISTS (
      SELECT 1 FROM "messages" m
      WHERE m."conversation_id" = c."id"
        AND m."role" = 'assistant'
        AND (
          m."content"->'parts'->0->'output'->'structuredContent'->>'name' = c."title"
          OR split_part(m."content"->'parts'->0->'output'->>'content', E'\n', 1) = c."title"
        )
    )
  );
