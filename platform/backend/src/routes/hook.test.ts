import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AuditLogModel, HookFileModel, MemberModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("hook routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let agentId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeAgent, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "admin" });
    const agent = await makeAgent({ organizationId, agentType: "agent" });
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

    const { default: hookRoutes } = await import("./hook");
    registerAuditLogHook(app);
    await app.register(hookRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("scoped hook editing denies another agent and revocation; changes are audited without script content", async ({
    makeCustomRole,
    makeAgent,
  }) => {
    const role = await makeCustomRole(organizationId, { permission: {} });
    await MemberModel.updateRole(user.id, organizationId, role.role);
    const key = { organizationId, resource: "agent" as const, scope: agentId };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [
        { subject: { type: "user", id: user.id }, actions: ["read", "update"] },
      ],
    });
    const payload = {
      agentId,
      event: "session_start",
      fileName: "check.py",
      content: "print('private script')",
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/hooks",
      payload,
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id;
    const other = await makeAgent({
      organizationId,
      agentType: "agent",
      scope: "personal",
    });
    const deniedCreate = await app.inject({
      method: "POST",
      url: "/api/hooks",
      payload: { ...payload, agentId: other.id },
    });
    expect(deniedCreate.statusCode).toBe(403);
    const deniedList = await app.inject({
      method: "GET",
      url: `/api/hooks?agentId=${other.id}`,
    });
    expect(deniedList.statusCode).toBe(403);
    const edited = await app.inject({
      method: "PUT",
      url: `/api/hooks/${id}`,
      payload: { content: "print('updated private script')" },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: id,
      limit: 10,
      offset: 0,
    });
    const update = audit.data.find((entry) => entry.action === "hook.updated");
    expect(update).toBeDefined();
    expect(update?.before).not.toEqual(update?.after);
    expect(JSON.stringify(audit.data)).not.toContain("private script");
    const current = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: current?.revision ?? 0,
      grants: [{ subject: { type: "user", id: user.id }, actions: ["read"] }],
    });
    for (const method of ["PUT", "DELETE"] as const) {
      const denied = await app.inject({
        method,
        url: `/api/hooks/${id}`,
        ...(method === "PUT" ? { payload: { enabled: false } } : {}),
      });
      expect(denied.statusCode, denied.body).toBe(403);
    }
    expect((await HookFileModel.findById(id, organizationId))?.enabled).toBe(
      true,
    );
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
