import type { User } from "./user";

declare module "fastify" {
  interface FastifyRequest {
    user: User;
    organizationId: string;
  }
}
