import type { FastifyRequest } from "fastify";

export function getPublicRequestOrigin(request: FastifyRequest): string {
  const host = request.host || "localhost";
  const protocol = (request.protocol || "http").replace(/:$/, "");

  return `${protocol}://${host}`;
}
