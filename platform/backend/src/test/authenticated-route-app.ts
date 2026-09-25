import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin";
import { createFastifyInstance } from "@/fastify-instance";

/** The request header that names the user a request acts as. */
export const USER_HEADER = "x-test-user";

/**
 * The given routes behind the real authentication middleware, so the role gate
 * of each endpoint applies as well as any object grant. Only the session
 * lookup is stubbed: it names the user in the `USER_HEADER` request header.
 *
 * Kept out of the `@/test` barrel: it loads the route graph.
 */
export async function authenticatedRouteApp(params: {
  organizationId: string;
  routes: FastifyPluginAsyncZod[];
}) {
  vi.spyOn(betterAuth.api, "getSession").mockImplementation((async ({
    headers,
  }: {
    headers: Headers;
  }) => {
    const userId = headers.get(USER_HEADER);
    return {
      response: userId
        ? {
            user: { id: userId },
            session: {
              id: `session-${userId}`,
              createdAt: new Date(),
              activeOrganizationId: params.organizationId,
            },
          }
        : null,
      headers: new Headers(),
    };
  }) as unknown as typeof betterAuth.api.getSession);
  const app = createFastifyInstance();
  await app.register(authPlugin);
  for (const routes of params.routes) {
    await app.register(routes);
  }
  return app;
}
