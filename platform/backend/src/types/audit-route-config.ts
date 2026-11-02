import type { AuditEventName } from "./audit-log";

/**
 * How a mutating route is audited. The Fastify route config augmentation
 * (types/fastify.d.ts) names it, so it lives with the types rather than with
 * the registry, which loads every model.
 */
export type AuditResourceIdSource =
  | "organizationContext"
  | "currentUser"
  | "currentUserPersonalToken";

export type AuditableRouteConfig = {
  resourceType: string;
  /**
   * Name of the route param that identifies the resource for `fetchById` and
   * `resource_id` (default: `id`). Use `agentId` for `/api/agents/:agentId/...`,
   * `roleId` for `/api/roles/:roleId`, etc.
   */
  resourceIdParam?: string;
  /**
   * When set, the audited resource id is not taken from route params.
   * - `organizationContext`: `request.organizationId` (org settings, bulk org routes).
   * - `currentUser`: `request.user.id` for personal account-level actions.
   * - `currentUserPersonalToken`: the caller's personal token row in the current org.
   */
  resourceIdSource?: AuditResourceIdSource;
  fetchById?: (
    id: string,
    organizationId: string,
    routeParams?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
  /**
   * Hard-coded action name; wins over actionByMethod and method-derivation.
   * Use for routes whose HTTP verb does not map to the semantic action
   * (rotations, syncs, imports, reinstalls, bulk ops).
   */
  action?: AuditEventName;
  /**
   * Per-method action override; falls through to deriveAction when absent.
   * Useful when a single route pattern handles multiple verbs with different
   * semantics.
   */
  actionByMethod?: Partial<
    Record<"POST" | "PUT" | "PATCH" | "DELETE", AuditEventName>
  >;
  /** Skip unsuccessful attempts; the route sets `auditSkip` for no-op successes. */
  onlyWhenChanged?: boolean;
};
