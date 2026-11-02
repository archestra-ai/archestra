import { randomUUID } from "node:crypto";
import { buildCustomAgentRuntime } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { afterEach, beforeEach } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
import type { User } from "@/types";
import type { AgentRuntimeTemplate } from "@/types/agent-runtime-template";
import routes from "./agent-runtime-template.routes";

export function useTemplateRouteTestApp() {
  const ctx = {} as {
    app: FastifyInstanceWithZod;
    organizationId: string;
    admin: User;
    member: User;
    viewer: User;
    caller: User;
  };
  beforeEach(
    async ({ makeUser, makeOrganization, makeMember, makeCustomRole }) => {
      ctx.organizationId = (await makeOrganization()).id;
      ctx.admin = await makeUser();
      ctx.member = await makeUser();
      ctx.viewer = await makeUser();
      await makeMember(ctx.admin.id, ctx.organizationId, { role: "admin" });
      await makeMember(ctx.member.id, ctx.organizationId, { role: "member" });
      const role = await makeCustomRole(ctx.organizationId, { permission: {} });
      await makeMember(ctx.viewer.id, ctx.organizationId, { role: role.role });
      ctx.caller = ctx.admin;
      ctx.app = createFastifyInstance();
      ctx.app.addHook("onRequest", async (request) => {
        Object.assign(request, {
          user: ctx.caller,
          organizationId: ctx.organizationId,
        });
      });
      registerRoutePermissions(ctx.app);
      registerAuditLogHook(ctx.app);
      await ctx.app.register(routes);
    },
  );
  afterEach(async () => {
    await ctx.app.close();
  });
  return ctx;
}

export function makeTemplate(
  overrides: Partial<AgentRuntimeTemplate> = {},
): AgentRuntimeTemplate {
  return {
    id: randomUUID(),
    name: "Engineering workspace",
    description: "Standard development environment",
    icon: null,
    hidden: false,
    position: 1,
    runtime: {
      ...buildCustomAgentRuntime({ image: "registry.example.com/agent:v1" }),
      privileged: false,
      environment: [{ key: "PROJECT_MODE", value: "test-private-setting" }],
    },
    ...overrides,
  };
}
