-- Custom SQL migration file, put your code below! --
UPDATE "knowledge_base_connectors"
SET "config" = ("config" - 'includeMarkdownFiles')
  || jsonb_build_object('includeRepositoryFiles', "config" -> 'includeMarkdownFiles')
WHERE "connector_type" = 'github'
  AND "config" ? 'includeMarkdownFiles';
