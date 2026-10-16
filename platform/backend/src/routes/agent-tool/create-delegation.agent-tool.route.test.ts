import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AgentToolModel, ToolModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import agentToolRoutes from "../agent-tool";

describe("POST /api/agents/:agentId/delegations/:targetAgentId", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(agentToolRoutes);
  });
  afterEach(async () => {
    await app.close();
  });
  const post = (source: string, target: string) =>
    app.inject({
      method: "POST",
      url: `/api/agents/${source}/delegations/${target}`,
    });
  const ids = async (source: string) =>
    (await AgentToolModel.getDelegationTargets(source))
      .map((row) => row.id)
      .sort();

  test("adds one edge without replacing existing targets and audits the agent update", async ({
    makeAgent,
  }) => {
    const source = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const existing = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
      name: "Existing target",
    });
    const added = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
      name: "Added target",
    });
    await AgentToolModel.assignDelegation({
      agentId: source.id,
      targetAgentId: existing.id,
    });
    const response = await post(source.id, added.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ created: true });
    expect(await ids(source.id)).toEqual([existing.id, added.id].sort());
    await expect
      .poll(async () => {
        const { data } = await AuditLogModel.findPaginated({
          organizationId,
          resourceType: "agent",
          limit: 20,
          offset: 0,
        });
        return data.find(
          (row) =>
            row.resourceId === source.id && row.action === "agent.updated",
        );
      })
      .toEqual(
        expect.objectContaining({ outcome: "success", resourceId: source.id }),
      );
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "agent",
      limit: 20,
      offset: 0,
    });
    const record = data.find(
      (row) => row.resourceId === source.id && row.action === "agent.updated",
    );
    expect(record?.before).not.toEqual(record?.after);
    expect(JSON.stringify(record?.after)).toContain(added.id);
    expect(JSON.stringify(record?.before)).not.toContain(added.id);
  });
  test("removing one edge audits an update and preserves its source agent", async ({
    makeAgent,
  }) => {
    const source = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const target = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    expect((await post(source.id, target.id)).statusCode).toBe(200);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/agents/${source.id}/delegations/${target.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(await ids(source.id)).toEqual([]);
    await expect
      .poll(async () => {
        const { data } = await AuditLogModel.findPaginated({
          organizationId,
          resourceType: "agent",
          limit: 20,
          offset: 0,
        });
        return data.find(
          (row) =>
            row.resourceId === source.id &&
            row.action === "agent.updated" &&
            JSON.stringify(row.before).includes(target.id) &&
            !JSON.stringify(row.after).includes(target.id),
        );
      })
      .toEqual(
        expect.objectContaining({ resourceId: source.id, outcome: "success" }),
      );
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "agent",
      limit: 20,
      offset: 0,
    });
    expect(
      data.filter(
        (row) => row.resourceId === source.id && row.action === "agent.deleted",
      ),
    ).toEqual([]);
  });
  test("concurrent independent edge creation preserves both targets", async ({
    makeAgent,
  }) => {
    const source = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const first = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
      name: "First concurrent target",
    });
    const second = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
      name: "Second concurrent target",
    });
    const responses = await Promise.all([
      post(source.id, first.id),
      post(source.id, second.id),
    ]);
    expect(responses.map((row) => row.statusCode)).toEqual([200, 200]);
    expect(responses.map((row) => row.json())).toEqual([
      { created: true },
      { created: true },
    ]);
    expect(await ids(source.id)).toEqual([first.id, second.id].sort());
  });
  test("duplicate requests are idempotent and do not create duplicate tools or audits", async ({
    makeAgent,
  }) => {
    const source = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const target = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const first = await post(source.id, target.id);
    expect(first.json()).toEqual({ created: true });
    const again = await post(source.id, target.id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ created: false });
    const concurrent = await Promise.all([
      post(source.id, target.id),
      post(source.id, target.id),
    ]);
    expect(concurrent.map((row) => row.json())).toEqual([
      { created: false },
      { created: false },
    ]);
    expect(await ids(source.id)).toEqual([target.id]);
    const tools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.delegateToAgentId, target.id));
    expect(tools).toHaveLength(1);
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "agent",
      limit: 20,
      offset: 0,
    });
    expect(
      data.filter(
        (row) => row.resourceId === source.id && row.action === "agent.updated",
      ),
    ).toHaveLength(1);
  });
  test("concurrent parents share one target tool", async ({ makeAgent }) => {
    const first = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const second = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const target = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const responses = await Promise.all([
      post(first.id, target.id),
      post(second.id, target.id),
    ]);
    expect(responses.map((row) => row.statusCode)).toEqual([200, 200]);
    expect(await ids(first.id)).toEqual([target.id]);
    expect(await ids(second.id)).toEqual([target.id]);
    expect(
      await db
        .select()
        .from(schema.toolsTable)
        .where(eq(schema.toolsTable.delegateToAgentId, target.id)),
    ).toHaveLength(1);
  });
  test("rejects foreign participants without changing existing edges", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const source = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const target = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const foreign = await makeAgent({
      agentType: "agent",
      organizationId: (await makeOrganization()).id,
    });
    expect((await post(source.id, foreign.id)).statusCode).toBe(404);
    expect((await post(foreign.id, target.id)).statusCode).toBe(404);
    expect(await ids(source.id)).toEqual([]);
    expect(await ids(foreign.id)).toEqual([]);
  });
  test("rejects a caller without source update access", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const source = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const target = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    user = await makeUser();
    await makeMember(user.id, organizationId);
    expect((await post(source.id, target.id)).statusCode).toBe(404);
    expect(await ids(source.id)).toEqual([]);
  });
  test("requires target read access even when the caller owns the source", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const admin = user;
    user = await makeUser();
    await makeMember(user.id, organizationId);
    const source = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const owned = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const hidden = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: admin.id,
      access: "personal",
    });
    expect((await post(source.id, owned.id)).statusCode).toBe(200);
    expect((await post(source.id, hidden.id)).statusCode).toBe(404);
    expect(await ids(source.id)).toEqual([owned.id]);
  });
  test("rejects self delegation and non-internal targets", async ({
    makeAgent,
  }) => {
    const source = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const gateway = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "mcp_gateway",
    });
    expect((await post(source.id, source.id)).statusCode).toBe(400);
    expect((await post(source.id, gateway.id)).statusCode).toBe(400);
    expect(await ids(source.id)).toEqual([]);
  });
  test("rejects a callable name collision without changing existing edges", async ({
    makeAgent,
  }) => {
    const source = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
    });
    const first = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
      name: "Same target name",
    });
    const second = await makeAgent({
      agentType: "agent",
      organizationId,
      authorId: user.id,
      name: "Same target name",
    });
    const before = await ToolModel.findDelegationTool(second.id);
    expect((await post(source.id, first.id)).statusCode).toBe(200);
    expect((await post(source.id, second.id)).statusCode).toBe(409);
    expect(await ids(source.id)).toEqual([first.id]);
    expect(await ToolModel.findDelegationTool(second.id)).toEqual(before);
  });
});
