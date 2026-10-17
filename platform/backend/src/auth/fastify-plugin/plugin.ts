import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { requestScope, shouldShareCallerLookups } from "@/auth/request-scope";
import { registerMcpDeploymentYamlResponseFilter } from "@/services/mcp-advanced-settings";
import { Authnz } from "./middleware";

export const authPlugin = fp(async (app: FastifyInstance) => {
  const authnz = new Authnz();

  app.decorateRequest("user");
  app.decorateRequest("organizationId");

  // Reads share one caller lookup across middleware, route and models.
  app.addHook("onRequest", (request, _reply, done) => {
    requestScope.enter({ memoize: shouldShareCallerLookups(request) });
    done();
  });

  app.addHook("preHandler", authnz.handle);
  registerMcpDeploymentYamlResponseFilter(app);
});
