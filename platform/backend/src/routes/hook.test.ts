import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { HookFileModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("hook routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let agentId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeAgent }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    const agent = await makeAgent({ organizationId });
    agentId = agent.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });
    registerAuditLogHook(app);

    const { default: hookRoutes } = await import("./hook");
    await app.register(hookRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("POST /api/hooks", () => {
    test("creates a hook with requirements and returns it", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/hooks",
        payload: {
          agentId,
          event: "session_start",
          fileName: "setup.py",
          content: "print('hello')",
          requirements: ["requests", "httpx"],
          enabled: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        agentId,
        event: "session_start",
        fileName: "setup.py",
        content: "print('hello')",
        requirements: ["requests", "httpx"],
        enabled: true,
      });
      expect(body.id).toBeDefined();
    });

    test("rejects an invalid file extension", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/hooks",
        payload: {
          agentId,
          event: "session_start",
          fileName: "notes.txt",
          content: "some content",
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test("returns 404 when agent belongs to another organization", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const otherOrg = await makeOrganization();
      const otherAgent = await makeAgent({ organizationId: otherOrg.id });

      const response = await app.inject({
        method: "POST",
        url: "/api/hooks",
        payload: {
          agentId: otherAgent.id,
          event: "session_start",
          fileName: "setup.py",
          content: "print('hello')",
        },
      });

      expect(response.statusCode).toBe(404);
    });

    test("returns 409 when a hook with the same agent, event, and file name already exists", async () => {
      const payload = {
        agentId,
        event: "session_start",
        fileName: "setup.py",
        content: "print('hello')",
      };

      const first = await app.inject({
        method: "POST",
        url: "/api/hooks",
        payload,
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/api/hooks",
        payload,
      });
      expect(second.statusCode).toBe(409);
    });
  });

  describe("POST /api/hooks/bulk", () => {
    async function getLatestVersion(id: string): Promise<number> {
      const [row] = await db
        .select({ latestVersion: schema.agentsTable.latestVersion })
        .from(schema.agentsTable)
        .where(eq(schema.agentsTable.id, id));
      return row?.latestVersion ?? -1;
    }

    test("creates all hooks and forks exactly one agent version", async () => {
      const versionBefore = await getLatestVersion(agentId);

      const response = await app.inject({
        method: "POST",
        url: "/api/hooks/bulk",
        payload: {
          agentId,
          hooks: [
            {
              event: "session_start",
              fileName: "setup.py",
              content: "print('one')",
            },
            {
              event: "session_start",
              fileName: "extra.py",
              content: "print('two')",
            },
            {
              event: "pre_tool_use",
              fileName: "check.py",
              content: "print('three')",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveLength(3);
      expect(body.map((h: { fileName: string }) => h.fileName).sort()).toEqual([
        "check.py",
        "extra.py",
        "setup.py",
      ]);

      const persisted = await HookFileModel.listByAgent(
        agentId,
        organizationId,
      );
      expect(persisted).toHaveLength(3);

      // The batch is one user action → exactly one new config version.
      expect(await getLatestVersion(agentId)).toBe(versionBefore + 1);

      const auditRows = await db
        .select({
          resourceType: schema.auditLogsTable.resourceType,
          resourceId: schema.auditLogsTable.resourceId,
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, "hook.bulk_created"),
            eq(schema.auditLogsTable.resourceId, organizationId),
          ),
        );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        resourceType: "hook",
        resourceId: organizationId,
      });
      expect(auditRows[0].before).toMatchObject({ hookFileCount: 0 });
      expect(auditRows[0].after).toMatchObject({ hookFileCount: 3 });
    });

    test("rejects the whole batch on conflicts, listing every pair", async () => {
      await HookFileModel.create({
        agentId,
        organizationId,
        event: "session_start",
        fileName: "setup.py",
        content: "print('existing')",
        requirements: [],
      });
      const versionBefore = await getLatestVersion(agentId);

      const response = await app.inject({
        method: "POST",
        url: "/api/hooks/bulk",
        payload: {
          agentId,
          hooks: [
            // Collides with the persisted hook.
            {
              event: "session_start",
              fileName: "setup.py",
              content: "print('dup')",
            },
            // Fine on its own...
            {
              event: "pre_tool_use",
              fileName: "check.py",
              content: "print('ok')",
            },
            // ...but duplicated within the payload.
            {
              event: "pre_tool_use",
              fileName: "check.py",
              content: "print('intra dup')",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(409);
      const message = response.json().error.message;
      expect(message).toContain("(session_start, setup.py)");
      expect(message).toContain("(pre_tool_use, check.py)");

      // All-or-nothing: nothing was created, nothing was forked.
      const persisted = await HookFileModel.listByAgent(
        agentId,
        organizationId,
      );
      expect(persisted).toHaveLength(1);
      expect(await getLatestVersion(agentId)).toBe(versionBefore);
    });

    test("returns 404 when the agent belongs to another organization", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const otherOrg = await makeOrganization();
      const otherAgent = await makeAgent({ organizationId: otherOrg.id });

      const response = await app.inject({
        method: "POST",
        url: "/api/hooks/bulk",
        payload: {
          agentId: otherAgent.id,
          hooks: [
            {
              event: "session_start",
              fileName: "setup.py",
              content: "print('hello')",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/hooks", () => {
    test("lists hooks for an agent", async () => {
      const hook = await HookFileModel.create({
        agentId,
        organizationId,
        event: "session_start",
        fileName: "setup.py",
        content: "print('hello')",
        requirements: ["requests"],
        enabled: true,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/hooks?agentId=${agentId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.map((h: { id: string }) => h.id)).toContain(hook.id);
    });

    test("returns empty array when agent has no hooks", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/hooks?agentId=${agentId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    test("returns 404 when agent belongs to another organization", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const otherOrg = await makeOrganization();
      const otherAgent = await makeAgent({ organizationId: otherOrg.id });

      const response = await app.inject({
        method: "GET",
        url: `/api/hooks?agentId=${otherAgent.id}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("PUT /api/hooks/:id", () => {
    test("updates an existing hook", async () => {
      const hook = await HookFileModel.create({
        agentId,
        organizationId,
        event: "session_start",
        fileName: "setup.py",
        content: "print('hello')",
        requirements: [],
        enabled: true,
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/hooks/${hook.id}`,
        payload: { enabled: false },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: hook.id,
        enabled: false,
      });
    });

    test("returns 400 when body is empty", async () => {
      const hook = await HookFileModel.create({
        agentId,
        organizationId,
        event: "session_start",
        fileName: "setup.py",
        content: "print('hello')",
        requirements: [],
        enabled: true,
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/hooks/${hook.id}`,
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });

    test("returns 404 when hook does not exist in the org", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/hooks/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        payload: { enabled: false },
      });

      expect(response.statusCode).toBe(404);
    });

    test("returns 409 when renaming a hook to a file name that already exists for the same agent and event", async () => {
      await HookFileModel.create({
        agentId,
        organizationId,
        event: "session_start",
        fileName: "a.py",
        content: "print('a')",
        requirements: [],
        enabled: true,
      });

      const hookB = await HookFileModel.create({
        agentId,
        organizationId,
        event: "session_start",
        fileName: "b.py",
        content: "print('b')",
        requirements: [],
        enabled: true,
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/hooks/${hookB.id}`,
        payload: { fileName: "a.py" },
      });

      expect(response.statusCode).toBe(409);
    });
  });

  describe("DELETE /api/hooks/:id", () => {
    test("deletes a hook and returns success", async () => {
      const hook = await HookFileModel.create({
        agentId,
        organizationId,
        event: "session_start",
        fileName: "setup.py",
        content: "print('hello')",
        requirements: [],
        enabled: true,
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/hooks/${hook.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });

      // Verify it's gone
      const listResponse = await app.inject({
        method: "GET",
        url: `/api/hooks?agentId=${agentId}`,
      });
      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toEqual([]);
    });

    test("returns 404 when hook does not exist in the org", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/hooks/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
