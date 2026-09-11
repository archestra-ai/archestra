import { RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { AgentModel, AgentPinModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("PUT/DELETE /api/agents/:id/pin", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeAdmin();
    await makeMember(admin.id, organizationId, { role: "admin" });
    actingUser = admin;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = actingUser;
    });
    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("pin/unpin surfaces caller-relative pinnedAt in the paginated list", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: admin.id,
      agentType: "agent",
      scope: "org",
    });

    const pin = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/pin`,
    });
    expect(pin.statusCode).toBe(200);

    let list = await listAgents(app, `name=${encodeURIComponent(agent.name)}`);
    expect(list.data).toHaveLength(1);
    expect(typeof list.data[0]?.pinnedAt).toBe("string");

    const unpaginated = await app.inject({
      method: "GET",
      url: "/api/agents/all?agentType=agent&excludeBuiltIn=true",
    });
    expect(unpaginated.statusCode).toBe(200);
    const allItem = unpaginated
      .json()
      .find((item: { id: string }) => item.id === agent.id);
    expect(allItem).not.toHaveProperty("pinnedAt");

    const unpin = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agent.id}/pin`,
    });
    expect(unpin.statusCode).toBe(200);

    list = await listAgents(app, `name=${encodeURIComponent(agent.name)}`);
    expect(list.data[0]?.pinnedAt).toBeNull();
  });

  test("pins are per-user", async ({ makeAgent, makeUser, makeMember }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: admin.id,
      agentType: "agent",
      scope: "org",
    });
    const member = await makeUser({ email: "agent-pin-member@test.com" });
    await makeMember(member.id, organizationId, {});

    actingUser = member;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/agents/${agent.id}/pin`,
        })
      ).statusCode,
    ).toBe(200);
    const memberList = await listAgents(
      app,
      `name=${encodeURIComponent(agent.name)}`,
    );
    expect(typeof memberList.data[0]?.pinnedAt).toBe("string");

    actingUser = admin;
    const adminList = await listAgents(
      app,
      `name=${encodeURIComponent(agent.name)}`,
    );
    expect(adminList.data[0]?.pinnedAt).toBeNull();
  });

  test("pinning an agent the caller cannot read returns 404", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const otherAuthor = await makeUser({ email: "agent-pin-owner@test.com" });
    const privateAgent = await makeAgent({
      organizationId,
      authorId: otherAuthor.id,
      agentType: "agent",
      scope: "personal",
    });
    const stranger = await makeUser({ email: "agent-pin-stranger@test.com" });
    await makeMember(stranger.id, organizationId, {});
    actingUser = stranger;

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${privateAgent.id}/pin`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("stale pins can be cleared after the agent becomes unreadable", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      authorId: admin.id,
      agentType: "agent",
      scope: "org",
    });
    await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/pin` });
    await AgentModel.delete(agent.id);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agent.id}/pin`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      (
        await AgentPinModel.getPinnedAtForAgents({
          userId: admin.id,
          agentIds: [agent.id],
        })
      ).has(agent.id),
    ).toBe(false);
  });

  test("pinned filters preserve totals, paginate, and order newest pin first", async ({
    makeAgent,
  }) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const alpha = await makeAgent({
      name: `Alpha ${suffix}`,
      organizationId,
      authorId: admin.id,
      agentType: "agent",
      scope: "org",
    });
    const bravo = await makeAgent({
      name: `Bravo ${suffix}`,
      organizationId,
      authorId: admin.id,
      agentType: "agent",
      scope: "org",
    });
    const charlie = await makeAgent({
      name: `Charlie ${suffix}`,
      organizationId,
      authorId: admin.id,
      agentType: "agent",
      scope: "org",
    });
    const zulu = await makeAgent({
      name: `Zulu ${suffix}`,
      organizationId,
      authorId: admin.id,
      agentType: "agent",
      scope: "org",
    });

    await AgentPinModel.pin({ userId: admin.id, agentId: alpha.id });
    await AgentPinModel.pin({ userId: admin.id, agentId: zulu.id });
    await db
      .update(schema.agentPinsTable)
      .set({ pinnedAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(
        and(
          eq(schema.agentPinsTable.userId, admin.id),
          eq(schema.agentPinsTable.agentId, alpha.id),
        ),
      );
    await db
      .update(schema.agentPinsTable)
      .set({ pinnedAt: new Date("2026-01-02T00:00:00.000Z") })
      .where(
        and(
          eq(schema.agentPinsTable.userId, admin.id),
          eq(schema.agentPinsTable.agentId, zulu.id),
        ),
      );

    const newest = await listAgents(
      app,
      `name=${suffix}&pinned=true&limit=1&offset=0&sortBy=name&sortDirection=asc`,
    );
    expect(newest.data.map((agent) => agent.id)).toEqual([zulu.id]);
    expect(newest.pagination.total).toBe(2);
    expect(newest.pagination.hasNext).toBe(true);

    const older = await listAgents(
      app,
      `name=${suffix}&pinned=true&limit=1&offset=1&sortBy=name&sortDirection=asc`,
    );
    expect(older.data.map((agent) => agent.id)).toEqual([alpha.id]);
    expect(older.pagination.total).toBe(2);

    const unpinned = await listAgents(
      app,
      `name=${suffix}&pinned=false&limit=10&offset=0&sortBy=name&sortDirection=desc`,
    );
    expect(unpinned.data.map((agent) => agent.id)).toEqual([
      charlie.id,
      bravo.id,
    ]);
    expect(unpinned.pagination.total).toBe(2);
    expect(unpinned.data.every((agent) => agent.pinnedAt === null)).toBe(true);
  });

  test("pin routes are registered for dynamic agent authorization", () => {
    expect(requiredEndpointPermissionsMap[RouteId.PinAgent]).toEqual({});
    expect(requiredEndpointPermissionsMap[RouteId.UnpinAgent]).toEqual({});
  });
});

async function listAgents(
  app: FastifyInstanceWithZod,
  query: string,
): Promise<{
  data: Array<{ id: string; pinnedAt: string | null }>;
  pagination: { total: number; hasNext: boolean };
}> {
  const params = new URLSearchParams({ limit: "100", offset: "0" });
  new URLSearchParams(query).forEach((value, key) => {
    params.set(key, value);
  });
  const response = await app.inject({
    method: "GET",
    url: `/api/agents?${params.toString()}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
