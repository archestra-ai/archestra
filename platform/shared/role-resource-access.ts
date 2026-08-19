import { z } from "zod";

/**
 * Per-role allow-lists for the built-in catalogs a role may reach: model
 * providers, knowledge connectors, messaging channels, and the clients offered
 * on the connection page.
 *
 * These replace the organization-wide "page settings" toggles that used to
 * live on three separate per-page modals. Access is a property of the role, so
 * one organization can offer different catalogs to different roles instead of
 * switching an entry off for everybody.
 *
 * The null/empty distinction is the whole contract:
 *
 * - `null` (no list stored) means **unrestricted** — every catalog entry is
 *   allowed, including entries added by a later release. This is the default a
 *   role starts with, so a new role is never accidentally locked out.
 * - `[]` (an empty list) means **nothing is allowed**. The chip control writes
 *   this when an admin removes the last chip.
 */

export const RoleResourceKindSchema = z.enum([
  "modelProviders",
  "knowledgeConnectors",
  "messagingChannels",
  "connectClients",
]);
export type RoleResourceKind = z.infer<typeof RoleResourceKindSchema>;

export const ROLE_RESOURCE_KINDS = Object.values(
  RoleResourceKindSchema.enum,
) as RoleResourceKind[];

/**
 * Deliberately `string[]` rather than the per-catalog enums. These lists are
 * stored data: a provider or connector type dropped from a later release must
 * read back as an unknown id we ignore, not as a 500 on every role fetch.
 * Callers narrow against their own catalog through {@link allowedFromCatalog}.
 */
const AllowListSchema = z.array(z.string()).nullable();

export const RoleResourceAccessSchema = z.object({
  modelProviders: AllowListSchema,
  knowledgeConnectors: AllowListSchema,
  messagingChannels: AllowListSchema,
  connectClients: AllowListSchema,
});
export type RoleResourceAccess = z.infer<typeof RoleResourceAccessSchema>;

/** What a role with nothing stored gets: every catalog, unrestricted. */
export const UNRESTRICTED_ROLE_RESOURCE_ACCESS: RoleResourceAccess = {
  modelProviders: null,
  knowledgeConnectors: null,
  messagingChannels: null,
  connectClients: null,
};

/**
 * Input shape for create/update: every kind is optional so a caller can send
 * just the section they edited, and an explicit `null` clears a restriction
 * back to "everything allowed".
 */
export const RoleResourceAccessInputSchema = z.object({
  modelProviders: AllowListSchema.optional(),
  knowledgeConnectors: AllowListSchema.optional(),
  messagingChannels: AllowListSchema.optional(),
  connectClients: AllowListSchema.optional(),
});
export type RoleResourceAccessInput = z.infer<
  typeof RoleResourceAccessInputSchema
>;

/** True when this role may use the catalog entry. */
export function isResourceAllowed(
  allowed: readonly string[] | null | undefined,
  id: string,
): boolean {
  return allowed == null || allowed.includes(id);
}

/**
 * The entries of `catalog` this role may use, in catalog order. An
 * unrestricted role gets the whole catalog, so entries shipped after the
 * allow-list was written stay available.
 */
export function allowedFromCatalog<Id extends string>(
  allowed: readonly string[] | null | undefined,
  catalog: readonly Id[],
): Id[] {
  if (allowed == null) return [...catalog];
  return catalog.filter((id) => allowed.includes(id));
}

/**
 * What the chip control should store for a selection.
 *
 * Selecting the whole catalog collapses back to `null` rather than pinning
 * today's ids: an admin who has not excluded anything has not asked to be
 * cut off from the next release's providers. Removing every chip stores `[]`,
 * which is a real "none allowed".
 */
export function collapseAllowList<Id extends string>(
  selected: readonly string[],
  catalog: readonly Id[],
): string[] | null {
  const chosen = catalog.filter((id) => selected.includes(id));
  return chosen.length === catalog.length ? null : chosen;
}

/**
 * The union of several roles' allow-lists, for the few decisions that have no
 * user to resolve against — a ChatOps bot deciding whether to listen at all.
 * One unrestricted role makes the union unrestricted.
 */
export function unionAllowLists(
  lists: readonly (readonly string[] | null | undefined)[],
): string[] | null {
  const union = new Set<string>();
  for (const list of lists) {
    if (list == null) return null;
    for (const id of list) union.add(id);
  }
  return [...union];
}

/** Human-readable heading for each section of the role access control. */
export const ROLE_RESOURCE_KIND_LABELS: Record<RoleResourceKind, string> = {
  modelProviders: "Model providers",
  knowledgeConnectors: "Knowledge connectors",
  messagingChannels: "Messaging channels",
  connectClients: "Connection page clients",
};
