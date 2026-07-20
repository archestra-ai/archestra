import { z } from "zod";

/**
 * Object-level visibility for knowledge sources.
 *
 * - `org-wide` — every chunk carries `org:*`; visible to everyone in the org.
 * - `team-scoped` — chunks carry `team:<id>` tokens; visible to team members.
 * - `auto-sync-permissions` — per-document ACLs synced from the upstream
 *   source's own access control (who can see a repo / space / project). The
 *   query tool returns only chunks the querying user is allowed to see upstream.
 *   Like `team-scoped`, gated behind the knowledge-base enterprise flag, and
 *   only allowed for connector types whose impl `supportsPermissionSync`.
 */
export const KnowledgeSourceVisibilitySchema = z.enum([
  "org-wide",
  "team-scoped",
  "auto-sync-permissions",
]);
export type KnowledgeSourceVisibility = z.infer<
  typeof KnowledgeSourceVisibilitySchema
>;
