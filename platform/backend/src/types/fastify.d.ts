import type { User } from "./user";
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
    /** Snapshot of the resource before the mutation; set by the audit preHandler hook. */
    auditBefore?: Record<string, unknown> | null;
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
