import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "@/auth";

export const authMiddleware = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  if (request.url.startsWith("/api/auth")) return;

  const headers = new Headers();
  Object.entries(request.headers).forEach(([key, value]) => {
    if (value) headers.append(key, value.toString());
  });

  try {
    const session = await auth.api.getSession({ headers });
    if (!session) {
      reply.status(401).send({ error: "Unauthorized" });
      return;
    }
    (request as any).user = session.user;
  } catch (_err) {
    reply.status(401).send({ error: "Invalid session" });
  }
};
