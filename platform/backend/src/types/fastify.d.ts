import type { User } from "./user";

declare module "fastify" {
  interface FastifyRequest {
    user: User;
    organizationId: string;
    /** Auth method used for this request; set by Authnz.populateUserInfo. */
    authMethod?: "session" | "api_key";
    /** Snapshot of the resource before the mutation; set by the audit preHandler hook. */
    auditBefore?: Record<string, unknown> | null;
    /** Timestamp captured at the start of preHandler, before the route handler executes. */
    auditOccurredAt?: Date;
    /** ID extracted from the POST response body; set by the audit onSend hook. */
    auditResponseBodyId?: string | null;
  }
}
