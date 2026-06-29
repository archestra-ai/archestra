import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { afterEach } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import type { User } from "@/types";
import { beforeEach } from "./fixtures";

export interface RouteTestApp {
  app: FastifyInstanceWithZod;
  user: User;
  organizationId: string;
}

/**
 * Registers beforeEach/afterEach hooks that boot the given route plugin behind
 * a stubbed authenticated request context (a fresh user and organization per
 * test). Call at describe/file level; the returned object's fields are
 * (re)populated before each test.
 */
export function useRouteTestApp(routes: FastifyPluginAsyncZod): RouteTestApp {
  // populated by the beforeEach below, before any test body runs
  const ctx = {} as RouteTestApp;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    ctx.user = await makeUser();
    ctx.organizationId = (await makeOrganization()).id;

    ctx.app = createFastifyInstance();
    ctx.app.addHook("onRequest", async (request) => {
      Object.assign(request, {
        user: ctx.user,
        organizationId: ctx.organizationId,
      });
    });
    await ctx.app.register(routes);
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  return ctx;
}
