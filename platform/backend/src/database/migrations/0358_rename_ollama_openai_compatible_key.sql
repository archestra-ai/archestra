-- The env-seeded Ollama key is now labelled "Ollama (OpenAI-compatible)" to
-- distinguish it from the new "Ollama (Native)" provider. Seeding only runs for
-- rows that do not exist yet, so deployments created before that change keep the
-- old "Ollama" label forever while new ones show the new string — screenshots and
-- docs can then only ever match one of them.
--
-- Scoped to rows still carrying the exact auto-seeded label: a key an admin has
-- since renamed is theirs, and is left alone.
UPDATE "chat_api_keys"
SET "name" = 'Ollama (OpenAI-compatible)'
WHERE "provider" = 'ollama'
  AND "name" = 'Ollama';
