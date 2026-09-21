import { createHash } from "node:crypto";
import { vi } from "vitest";
import {
  executeArchestraTool,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import { betterAuth } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin/plugin";
import config from "@/config";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import { openappaBatteriesService } from "@/openappa/batteries";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import routes from "./guardrails-policy.routes";

const content =
  '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n';

describe("guardrails policy authoring", () => {
  let app: FastifyInstanceWithZod;
  let orgId: string;
  let userId: string;

  beforeEach(
    async ({ makeOrganization, makeUser, makeMember, makeSession }) => {
      config.openappa.enabled = true;
      orgId = (await makeOrganization()).id;
      const user = await makeUser();
      userId = user.id;
      await makeMember(user.id, orgId, { role: "admin" });
      const session = await makeSession(user.id, {
        activeOrganizationId: orgId,
      });
      vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
        response: { user, session },
        headers: new Headers(),
      } as never);
      app = createFastifyInstance();
      await app.register(authPlugin);
      registerAuditLogHook(app);
      await app.register(routes);
    },
  );
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  test("persists valid text, detects stale edits, and records the revision in the audit trail", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/guardrails-policy",
      payload: { content, expectedRevision: 0 },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      content,
      revision: 1,
      updatedBy: userId,
    });
    const loaded = await app.inject({
      method: "GET",
      url: "/api/guardrails-policy",
    });
    expect(loaded.json()).toMatchObject({ content, revision: 1 });
    const conflict = await app.inject({
      method: "PUT",
      url: "/api/guardrails-policy",
      payload: { content: `${content}# stale\n`, expectedRevision: 0 },
    });
    expect(conflict.statusCode).toBe(409);
    expect((await GuardrailsPolicyModel.findLatest(orgId))?.content).toBe(
      content,
    );
    await vi.waitFor(async () => {
      const rows = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 20,
        offset: 0,
      });
      expect(
        rows.data.some(
          (row) =>
            row.action === "guardrailsPolicy.updated" &&
            row.after?.revision === 1,
        ),
      ).toBe(true);
    });
  });

  test("only one of two concurrent writers can advance the same revision", async () => {
    const responses = await Promise.all(
      [`${content}# first`, `${content}# second`].map((text) =>
        app.inject({
          method: "PUT",
          url: "/api/guardrails-policy",
          payload: { content: text, expectedRevision: 0 },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const winner = responses
      .find((response) => response.statusCode === 200)
      ?.json();
    expect(await GuardrailsPolicyModel.findLatest(orgId)).toMatchObject({
      content: winner.content,
      revision: 1,
    });
  });

  test("organization policies are stored separately", async ({
    makeOrganization,
  }) => {
    await app.inject({
      method: "PUT",
      url: "/api/guardrails-policy",
      payload: { content, expectedRevision: 0 },
    });
    const other = await makeOrganization();
    expect(await GuardrailsPolicyModel.findLatest(other.id)).toBeNull();
  });

  test("rejects invalid contracts and container access without replacing a saved policy", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/guardrails-policy",
      payload: { content, expectedRevision: 0 },
    });
    for (const invalid of [
      "[policy]\nversion = 999",
      `${content}[externals.annotators.x]\ncommand = ["sh"]`,
      `include = ["/secret"]\n${content}`,
      // The host keeps its helper-bridge bearer to itself.
      `${content}[externals.authorities.review]\nurl = "http://127.0.0.1:9000/api/openappa/helpers/x/y"\ntoken_env = "APPA_ARCHESTRA_BRIDGE_TOKEN"\n`,
    ]) {
      const validation = await app.inject({
        method: "POST",
        url: "/api/guardrails-policy/validate",
        payload: { content: invalid },
      });
      expect(validation.json().valid).toBe(false);
      const save = await app.inject({
        method: "PUT",
        url: "/api/guardrails-policy",
        payload: { content: invalid, expectedRevision: 1 },
      });
      expect(save.statusCode).toBe(400);
    }
    expect((await GuardrailsPolicyModel.findLatest(orgId))?.revision).toBe(1);
  });

  test("the agent edits the same policy and respects revision conflicts", async () => {
    const context = {
      organizationId: orgId,
      userId,
      agent: { id: "test-agent", name: "Test assistant" },
    };
    const saved = await executeArchestraTool(
      "archestra__update_guardrails_policy",
      { content, expectedRevision: 0 },
      context,
    );
    expect(saved.isError).not.toBe(true);
    const loaded = await app.inject({
      method: "GET",
      url: "/api/guardrails-policy",
    });
    expect(loaded.json()).toMatchObject({ content, revision: 1 });
    await vi.waitFor(async () => {
      const rows = await AuditLogModel.findPaginated({
        organizationId: orgId,
        limit: 20,
        offset: 0,
      });
      expect(
        rows.data.some(
          (row) =>
            row.action === "guardrailsPolicy.updated" &&
            row.after?.revision === 1,
        ),
      ).toBe(true);
    });
    await expect(
      executeArchestraTool(
        "archestra__update_guardrails_policy",
        { content, expectedRevision: 0 },
        context,
      ),
    ).rejects.toThrow("This policy changed");
  });

  test("granting a battery a credential needs credential update, removing it does not", async ({
    makeUser,
    makeCustomRole,
    makeMember,
    makeSession,
  }) => {
    const author = await makeUser();
    const role = await makeCustomRole(orgId, {
      permission: { toolPolicy: ["read", "update"] },
    });
    await makeMember(author.id, orgId, { role: role.role });
    const session = await makeSession(author.id, {
      activeOrganizationId: orgId,
    });
    vi.mocked(betterAuth.api.getSession).mockResolvedValue({
      response: { user: author, session },
      headers: new Headers(),
    } as never);
    const context = {
      organizationId: orgId,
      userId: author.id,
      agent: { id: "test-agent", name: "Test assistant" },
    };
    const declared = `include = ["batteries/github/appa.toml"]\n\n${content}`;
    const granted = `${declared}\n[credentials]\nAPPA_PROVIDER_GITHUB_TOKEN = "github-token"\n`;
    // Including a battery that reads no bound variable grants nothing.
    const included = await app.inject({
      method: "PUT",
      url: "/api/guardrails-policy",
      payload: { content: declared, expectedRevision: 0 },
    });
    expect(included.statusCode, included.body).toBe(200);
    const refused = await app.inject({
      method: "PUT",
      url: "/api/guardrails-policy",
      payload: { content: granted, expectedRevision: 1 },
    });
    expect(refused.statusCode).toBe(403);
    // The agent path is the same authorization, not a way around it.
    await expect(
      executeArchestraTool(
        "archestra__update_guardrails_policy",
        { content: granted, expectedRevision: 1 },
        context,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await GuardrailsPolicyModel.findLatest(orgId))?.revision).toBe(1);

    const binder = await makeUser();
    await makeMember(binder.id, orgId, { role: "admin" });
    const binderSession = await makeSession(binder.id, {
      activeOrganizationId: orgId,
    });
    vi.mocked(betterAuth.api.getSession).mockResolvedValue({
      response: { user: binder, session: binderSession },
      headers: new Headers(),
    } as never);
    const bound = await app.inject({
      method: "PUT",
      url: "/api/guardrails-policy",
      payload: { content: granted, expectedRevision: 1 },
    });
    expect(bound.statusCode, bound.body).toBe(200);

    // Giving a grant up is policy authoring like any other.
    vi.mocked(betterAuth.api.getSession).mockResolvedValue({
      response: { user: author, session },
      headers: new Headers(),
    } as never);
    const removed = await app.inject({
      method: "PUT",
      url: "/api/guardrails-policy",
      payload: { content: declared, expectedRevision: 2 },
    });
    expect(removed.statusCode, removed.body).toBe(200);
  });

  test("an entry spelling bytes nobody stored is refused when it is added and unavailable when it stays", async () => {
    const unknown = `include = ["batteries/acme@sha256-${"a".repeat(64)}/appa.toml"]\n\n${content}`;
    const added = await app.inject({
      method: "PUT",
      url: "/api/guardrails-policy",
      payload: { content: unknown, expectedRevision: 0 },
    });
    expect(added.statusCode).toBe(400);
    // The same entry in text that is already the latest revision is the
    // author's problem to fix, not a reason to refuse every later edit.
    await GuardrailsPolicyModel.save({
      organizationId: orgId,
      updatedBy: userId,
      content: unknown,
      contentHash: createHash("sha256").update(unknown).digest("hex"),
      expectedRevision: 0,
    });
    const kept = await app.inject({
      method: "PUT",
      url: "/api/guardrails-policy",
      payload: { content: `${unknown}# a later edit\n`, expectedRevision: 1 },
    });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(
      await openappaBatteriesService.policyDeclarations(orgId),
    ).toMatchObject({
      batteries: [{ name: "acme", status: "unavailable" }],
    });
  });

  test("disabled feature hides API and agent tools", async () => {
    config.openappa.enabled = false;
    for (const [method, url, payload] of [
      ["GET", "/api/guardrails-policy", undefined],
      ["PUT", "/api/guardrails-policy", { content, expectedRevision: 0 }],
      ["POST", "/api/guardrails-policy/validate", { content }],
    ] as const) {
      expect((await app.inject({ method, url, payload })).statusCode).toBe(404);
    }
    expect(
      getArchestraMcpTools().filter((tool) =>
        tool.name.includes("guardrails_policy"),
      ),
    ).toEqual([]);
    await expect(
      executeArchestraTool(
        "archestra__update_guardrails_policy",
        { content, expectedRevision: 0 },
        { organizationId: orgId, userId, agent: { id: "a", name: "A" } },
      ),
    ).rejects.toMatchObject({ code: -32601 });
  });

  test("a member can read but cannot save or validate policies through either API", async ({
    makeUser,
    makeMember,
    makeSession,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, orgId, { role: "member" });
    const session = await makeSession(user.id, { activeOrganizationId: orgId });
    vi.mocked(betterAuth.api.getSession).mockResolvedValue({
      response: { user, session },
      headers: new Headers(),
    } as never);
    expect(
      (await app.inject({ method: "GET", url: "/api/guardrails-policy" }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/guardrails-policy",
          payload: { content, expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/guardrails-policy/validate",
          payload: { content },
        })
      ).statusCode,
    ).toBe(403);
    const denied = await executeArchestraTool(
      "archestra__update_guardrails_policy",
      { content, expectedRevision: 0 },
      { organizationId: orgId, userId: user.id, agent: { id: "a", name: "A" } },
    );
    expect(denied.isError).toBe(true);
    expect(await GuardrailsPolicyModel.findLatest(orgId)).toBeNull();
  });
});
