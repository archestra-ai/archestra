import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { auth } from "@/auth";
import db, { schema } from "@/database";

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
 * Extracts the user from the current request session or API key
 */
export async function getUserFromRequest(
  request: FastifyRequest,
): Promise<{ id: string; isAdmin: boolean; organizationId: string } | null> {
  const session = await auth.api.getSession({
    headers: new Headers(request.headers as HeadersInit),
    query: { disableCookieCache: true },
  });

  if (!session?.user?.id) {
    return null;
  }

  // For API key auth, the session might not have activeOrganizationId
  // so we need to get the user's organization from the member table
  let organizationId = session.session?.activeOrganizationId;

  if (!organizationId) {
    // This is likely an API key request, get the user's first organization
    const userMembership = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.userId, session.user.id))
      .limit(1);

    if (userMembership[0]) {
      organizationId = userMembership[0].organizationId;
    }
  }

  if (!organizationId) {
    return null;
  }

  return {
    id: session.user.id,
    isAdmin: session.user.role === "admin",
    organizationId,
  };
}
