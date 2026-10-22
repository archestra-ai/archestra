import Fastify from "fastify";

/** Keep startup/liveness probes alive without admitting traffic during upgrades. */
export function createStartupHealthServer() {
  // No startup request needs draining. An incomplete client request must not
  // hold the port open when the real API is ready to take over.
  const server = Fastify({ forceCloseConnections: true });
  server.get("/health", async () => ({ status: "ok" }));
  server.setNotFoundHandler((_request, reply) => {
    return reply.code(503).send({ status: "starting" });
  });
  return server;
}
