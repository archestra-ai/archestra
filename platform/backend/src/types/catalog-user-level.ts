/**
 * Per-user grants on a catalog item. Catalog sharing (apps) was the first
 * surface to get them; the concept now covers every shareable resource, so the
 * definitions live in `resource-user-level` and this module only names them in
 * catalog terms for the callers that already read that way.
 */
export {
  DEFAULT_RESOURCE_USER_ACCESS_LEVEL as DEFAULT_CATALOG_USER_ACCESS_LEVEL,
  normalizeResourceUserInput as normalizeCatalogUserInput,
  type ResourceUserAccessLevel as CatalogUserAccessLevel,
  ResourceUserAccessLevelSchema as CatalogUserAccessLevelSchema,
  type ResourceUserAssignment as CatalogUserAssignment,
  type ResourceUserInput as CatalogUserInput,
  ResourceUserInputSchema as CatalogUserInputSchema,
} from "./resource-user-level";
