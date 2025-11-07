import type { FastifyInstance } from "fastify";
import { Authnz } from "./middleware";

export const authPlugin = (app: FastifyInstance) => {
  const authnz = new Authnz();

  app.decorateRequest("user");
  app.decorateRequest("organizationId");
  app.addHook("preHandler", authnz.handle);
};
