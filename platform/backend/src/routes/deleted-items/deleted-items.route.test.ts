import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { softDelete } from "@/database/soft-delete";
import { AgentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("Deleted Items routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: deletedItemsRoutes } = await import(
      "./deleted-items.routes"
    );
    await app.register(deletedItemsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function softDeleteAgent(agentId: string) {
    await softDelete(
      db,
      schema.agentsTable,
      eq(schema.agentsTable.id, agentId),
    );
  }

  describe("GET /api/deleted-items", () => {
    test("lists soft-deleted entities with their type and restorability", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId, name: "Retired" });
      await softDeleteAgent(agent.id);

      const response = await app.inject({
        method: "GET",
        url: "/api/deleted-items",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        entityType: "agent",
        id: agent.id,
        name: "Retired",
        restorable: true,
      });
      expect(body.pagination.total).toBe(1);
    });

    test("omits active rows and other organizations' rows", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const active = await makeAgent({ organizationId });
      const otherOrg = await makeOrganization();
      const foreign = await makeAgent({ organizationId: otherOrg.id });
      await softDeleteAgent(foreign.id);

      const response = await app.inject({
        method: "GET",
        url: "/api/deleted-items",
      });

      expect(response.json().data).toEqual([]);
      expect(await AgentModel.findById(active.id)).not.toBeNull();
    });

    test("filters by entity type", async ({ makeAgent }) => {
      const agent = await makeAgent({ organizationId });
      await softDeleteAgent(agent.id);

      const matching = await app.inject({
        method: "GET",
        url: "/api/deleted-items?entityTypes=agent",
      });
      expect(matching.json().data).toHaveLength(1);

      const other = await app.inject({
        method: "GET",
        url: "/api/deleted-items?entityTypes=skill",
      });
      expect(other.json().data).toEqual([]);
    });
  });

  describe("POST /api/deleted-items/:entityType/:id/restore", () => {
    test("brings a soft-deleted agent back", async ({ makeAgent }) => {
      const agent = await makeAgent({ organizationId });
      await softDeleteAgent(agent.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/deleted-items/agent/${agent.id}/restore`,
      });

      expect(response.statusCode).toBe(200);
      expect(await AgentModel.findById(agent.id)).not.toBeNull();
    });

    test("404s for an active row", async ({ makeAgent }) => {
      const agent = await makeAgent({ organizationId });

      const response = await app.inject({
        method: "POST",
        url: `/api/deleted-items/agent/${agent.id}/restore`,
      });

      expect(response.statusCode).toBe(404);
    });

    test("404s for another organization's row", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const foreign = await makeAgent({ organizationId: otherOrg.id });
      await softDeleteAgent(foreign.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/deleted-items/agent/${foreign.id}/restore`,
      });

      expect(response.statusCode).toBe(404);
      expect(
        await AgentModel.findDeletedByIdForOrganization(
          foreign.id,
          otherOrg.id,
        ),
      ).not.toBeNull();
    });

    test("400s for an app, which has no restore path", async ({
      makeApp,
      makeUser,
    }) => {
      const author = await makeUser();
      const app_ = await makeApp({ organizationId, authorId: author.id });
      await softDelete(db, schema.appsTable, eq(schema.appsTable.id, app_.id));

      const response = await app.inject({
        method: "POST",
        url: `/api/deleted-items/app/${app_.id}/restore`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toMatch(/cannot be restored/i);
    });

    test("409s when something reused the name freed by the delete", async ({
      makeAgent,
    }) => {
      // Deleting frees the slug — the unique index is partial on active rows —
      // so a new agent can claim it, and then the restore genuinely cannot land.
      // The two slugs are set directly to stage that collision without relying
      // on how names happen to be slugified.
      const original = await makeAgent({ organizationId, name: "Reused" });
      await db
        .update(schema.agentsTable)
        .set({ slug: "reused" })
        .where(eq(schema.agentsTable.id, original.id));
      await softDeleteAgent(original.id);

      const replacement = await makeAgent({
        organizationId,
        name: "Reused Again",
      });
      await db
        .update(schema.agentsTable)
        .set({ slug: "reused" })
        .where(eq(schema.agentsTable.id, replacement.id));

      const response = await app.inject({
        method: "POST",
        url: `/api/deleted-items/agent/${original.id}/restore`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toMatch(/already using this name/i);
    });
  });

  describe("DELETE /api/deleted-items/:entityType/:id", () => {
    test("permanently removes the row", async ({ makeAgent }) => {
      const agent = await makeAgent({ organizationId });
      await softDeleteAgent(agent.id);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/deleted-items/agent/${agent.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(
        await AgentModel.findDeletedByIdForOrganization(
          agent.id,
          organizationId,
        ),
      ).toBeNull();
    });

    test("records the purge against the admin who performed it", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId, name: "Gone" });
      await softDeleteAgent(agent.id);

      await app.inject({
        method: "DELETE",
        url: `/api/deleted-items/agent/${agent.id}`,
      });

      const [record] = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.resourceId, agent.id));
      expect(record.action).toBe("agent.purged");
      expect(record.actorType).toBe("user");
      expect(record.actorId).toBe(user.id);
    });

    test("404s for an active row rather than hard-deleting it", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/deleted-items/agent/${agent.id}`,
      });

      expect(response.statusCode).toBe(404);
      expect(await AgentModel.findById(agent.id)).not.toBeNull();
    });

    test("404s for another organization's row", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const foreign = await makeAgent({ organizationId: otherOrg.id });
      await softDeleteAgent(foreign.id);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/deleted-items/agent/${foreign.id}`,
      });

      expect(response.statusCode).toBe(404);
      expect(
        await AgentModel.findDeletedByIdForOrganization(
          foreign.id,
          otherOrg.id,
        ),
      ).not.toBeNull();
    });
  });
});
