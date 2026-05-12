import type { User } from "./user";

declare module "fastify" {
  interface FastifyRequest {
    user: User;
    organizationId: string;
    /** Snapshot of the resource before the mutation; set by the audit preHandler hook. */
    auditPriorState?: Record<string, unknown> | null;
    /** ID extracted from the POST response body; set by the audit onSend hook. */
    auditResponseBodyId?: string | null;
  }
}
