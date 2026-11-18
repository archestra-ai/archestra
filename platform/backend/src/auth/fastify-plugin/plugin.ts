import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { requestScope, shouldShareCallerLookups } from "@/auth/request-scope";
import config from "@/config";
import { isLlmProxyPath } from "@/routes/route-paths";
import { registerMcpDeploymentYamlResponseFilter } from "@/services/mcp-advanced-settings";
import { Authnz } from "./middleware";

export const authPlugin = fp(async (app: FastifyInstance) => {
  const authnz = new Authnz();

  app.decorateRequest("user");
  app.decorateRequest("organizationId");

  // Bind the request scope, so a read resolves the caller once for the
  // middleware, the route and the models.
  app.addHook("onRequest", (request, _reply, done) => {
    requestScope.enter({
      memoize: shouldShareCallerLookups(request),
      // A site far from its database serves LLM proxy configuration reads
      // from the pool read cache (see `sites/README.md`).
      cachesReads: config.site.remoteDatabase && isLlmProxyPath(request.url),
    });
    done();
  });

  app.addHook("preHandler", authnz.handle);
  registerMcpDeploymentYamlResponseFilter(app);
});
