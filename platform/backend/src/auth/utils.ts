import type { FastifyRequest } from "fastify";
import { auth } from "@/auth/auth";

/**
 * Extracts the user from the current request session
 */
export async function getUserFromRequest(
  request: FastifyRequest,
): Promise<{ id: string; isAdmin: boolean } | null> {
  const session = await auth.api.getSession({
    headers: new Headers(request.headers as HeadersInit),
    query: { disableCookieCache: true },
  });

  if (!session?.user?.id || !session?.session?.activeOrganizationId) {
    return null;
  }

  return {
    id: session.user.id,
    isAdmin: session.user.role === "admin",
  };
}
