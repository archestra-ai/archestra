import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { AgentModel, AuditLogModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import type { User } from "@/types";
import agentRoutes from "./agent";

const AGENT_IDENTITY = "da6ea4f9-7512-4341-bbc5-ce4298a97a31";

describe("Entra agent identity binding on agents", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;
  let editor: User;
  let agentId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeAdmin,
      makeUser,
      makeMember,
      makeAgent,
    }) => {
      organizationId = (await makeOrganization()).id;
      admin = await makeAdmin();
      await makeMember(admin.id, organizationId, { role: "admin" });
      // May edit this one agent, but not identity providers.
      editor = await makeUser();
      await makeMember(editor.id, organizationId);
      agentId = (
        await makeAgent({
          organizationId,
          authorId: admin.id,
          access: { users: [editor.id], preset: "edit" },
        })
      ).id;
      app = await authenticatedRouteApp({
        organizationId,
        routes: [agentRoutes],
        auditLog: true,
      });
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("binds an identity for a user who may update identity providers, and audits it", async () => {
    const response = await update(admin, agentId, {
      entraAgentIdentityId: AGENT_IDENTITY,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().entraAgentIdentityId).toBe(AGENT_IDENTITY);
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: agentId,
      action: "agent.updated",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    expect(data[0].before).toMatchObject({ entraAgentIdentityId: null });
    expect(data[0].after).toMatchObject({
      entraAgentIdentityId: AGENT_IDENTITY,
    });
  });

  test("refuses a binding from an agent editor without identityProvider:update", async () => {
    const response = await update(editor, agentId, {
      entraAgentIdentityId: AGENT_IDENTITY,
    });

    expect(response.statusCode).toBe(403);
    expect(await AgentModel.findEntraAgentIdentityId(agentId)).toBeNull();
  });

  test("lets an agent editor save other changes while the binding stays as it is", async () => {
    await AgentModel.update(agentId, { entraAgentIdentityId: AGENT_IDENTITY });

    const response = await update(editor, agentId, {
      name: "Renamed",
      entraAgentIdentityId: AGENT_IDENTITY.toUpperCase(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe("Renamed");
  });

  test("refuses an identity already bound to another agent, in any case", async ({
    makeAgent,
  }) => {
    await AgentModel.update(agentId, { entraAgentIdentityId: AGENT_IDENTITY });
    const other = await makeAgent({ organizationId, authorId: admin.id });

    const response = await update(admin, other.id, {
      entraAgentIdentityId: AGENT_IDENTITY.toUpperCase(),
    });

    expect(response.statusCode).toBe(409);
    expect(await AgentModel.findEntraAgentIdentityId(other.id)).toBeNull();
  });

  test("refuses an identity that is not an application ID", async () => {
    const response = await update(admin, agentId, {
      entraAgentIdentityId: "agent-alpha",
    });

    expect(response.statusCode).toBe(400);
  });

  // ===== Helpers =====

  function update(as: User, id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PUT",
      url: `/api/agents/${id}`,
      headers: { [USER_HEADER]: as.id },
      payload,
    });
  }
});
