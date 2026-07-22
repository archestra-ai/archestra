import type { User } from "./user";
import type { AuditableRouteConfig } from "../middleware/audit-log-registry";
import type {
  SelectServiceAccount,
  SelectServiceAccountToken,
} from "./service-account";

declare module "fastify" {
  interface FastifyRequest {
    user: User;
    organizationId: string;
    /** Auth method used for this request; set by Authnz.populateUserInfo. */
    authMethod?: "session" | "api_key" | "service_account";
    serviceAccount?: SelectServiceAccount;
    serviceAccountAuthResult?: {
      serviceAccount: SelectServiceAccount;
      token: SelectServiceAccountToken;
    };
    /** Sanitized snapshot of the resource before the mutation; set by the audit preHandler hook. */
    auditBefore?: Record<string, unknown> | null;
    /**
     * Memoized effective audit route config, computed once by whichever audit
     * hook needs it first. Wrapped so a legitimately-undefined resolved config
     * is still marked as computed.
     */
    auditEffectiveCfg?: { value: AuditableRouteConfig | undefined };
    /**
     * Memoized audited resource id, computed once by whichever audit hook
     * needs it first. Wrapped so a legitimately-null resolved id is still
     * marked as computed.
     */
    auditResourceId?: { value: string | null };
    /**
     * Post-state supplied by a route handler for the audit `after` snapshot,
     * used when the generic `fetchById` snapshot can't represent the result —
     * e.g. a bulk create that yields multiple ids. When set, the onResponse
     * hook uses this verbatim instead of calling `fetchById`.
     */
    auditAfter?: Record<string, unknown> | null;
    /** Timestamp captured at the start of preHandler, before the route handler executes. */
    auditOccurredAt?: Date;
    /** ID extracted from the POST response body; set by the audit onSend hook. */
    auditResponseBodyId?: string | null;
  }
}
