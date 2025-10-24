import type { FastifyRequest } from "fastify";
import { auth } from "@/auth";

export function prepareErrorResponse(
  message: string,
  request: FastifyRequest,
  data?: object,
) {
  return {
    message,
    request: {
      method: request.method,
      url: request.url,
    },
    data,
  };
}

/**
 * Extracts the user from the current request session
 */
export async function getUserFromRequest(
  request: FastifyRequest,
): Promise<{ id: string; isAdmin: boolean; organizationId: string } | null> {
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
    organizationId: session.session.activeOrganizationId,
  };
}
