import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { registerMcpDeploymentYamlResponseFilter } from "@/services/mcp-advanced-settings";
import { Authnz } from "./middleware";

export const authPlugin = fp(async (app: FastifyInstance) => {
  const authnz = new Authnz();

  app.decorateRequest("user");
  app.decorateRequest("organizationId");

  app.addHook("preHandler", authnz.handle);
  registerMcpDeploymentYamlResponseFilter(app);
});
