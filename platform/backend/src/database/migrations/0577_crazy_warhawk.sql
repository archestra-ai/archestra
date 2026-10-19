CREATE INDEX "tools_ui_resource_catalog_idx" ON "tools" USING btree ("catalog_id") WHERE coalesce(
    case when "tools"."meta"->'_meta'->'ui'->>'resourceUri' like 'ui://%' then "tools"."meta"->'_meta'->'ui'->>'resourceUri' end,
    case when "tools"."meta"->'_meta'->>'ui/resourceUri' like 'ui://%' then "tools"."meta"->'_meta'->>'ui/resourceUri' end
  ) is not null;