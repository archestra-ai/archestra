import { vi } from "vitest";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import AuditLogModel from "@/models/audit-log";
import OrganizationModel from "@/models/organization";
import { describe, expect, test } from "@/test";
import {
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

describe("PUT /api/agent-runtime-templates/settings", () => {
  const ctx = useTemplateRouteTestApp();
  const save = (payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: "PUT",
      url: "/api/agent-runtime-templates/settings",
      payload,
    });

  test("persists templates and combined order, then edits and deletes without changing existing agents", async ({
    makeAgent,
  }) => {
    const template = makeTemplate();
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "agent",
      runtime: template.runtime,
    });
    const overrides = {
      codex: { position: 0 },
      "claude-code": { position: 2, hidden: true },
    };
    const created = await save({
      revision: 0,
      templates: [template],
      popularAgentOverrides: overrides,
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toEqual({
      revision: 1,
      templates: [template],
      popularAgentOverrides: overrides,
    });
    const stored = await db.select().from(schema.secretsTable);
    expect(stored.some((row) => "__encrypted" in row.secret)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain("test-private-setting");
    expect(
      await OrganizationModel.getById(ctx.organizationId),
    ).not.toHaveProperty("runtimeTemplateSettings");
    expect(await OrganizationModel.getFirst()).not.toHaveProperty(
      "runtimeTemplateSettings",
    );
    expect(
      await OrganizationModel.patch(ctx.organizationId, {
        name: "Updated organization",
      }),
    ).not.toHaveProperty("runtimeTemplateSettings");
    expect(
      (await OrganizationModel.getById(ctx.organizationId))
        ?.popularAgentOverrides,
    ).toEqual(overrides);
    const edited = {
      ...template,
      name: "Review workspace",
      runtime: { ...template.runtime, image: "registry.example.com/agent:v2" },
    };
    expect(
      (
        await save({
          revision: 1,
          templates: [edited],
          popularAgentOverrides: overrides,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await AgentRuntimeTemplateModel.getSettings(ctx.organizationId))
        .templates,
    ).toEqual([edited]);
    expect(
      (await save({ revision: 2, templates: [], popularAgentOverrides: null }))
        .statusCode,
    ).toBe(200);
    expect((await AgentModel.findById(agent.id))?.runtime).toEqual(
      template.runtime,
    );
  });

  test("rejects a stale revision and redacts environment values from audit snapshots", async () => {
    const template = makeTemplate({
      icon: "data:image/png;base64,dGVzdC1pY29u",
    });
    const body = {
      revision: 0,
      templates: [template],
      popularAgentOverrides: null,
    };
    expect((await save(body)).statusCode).toBe(200);
    expect((await save({ ...body, templates: [] })).statusCode).toBe(409);
    expect(
      (await AgentRuntimeTemplateModel.getSettings(ctx.organizationId))
        .templates,
    ).toEqual([template]);
    await vi.waitFor(async () => {
      const { data } = await AuditLogModel.findPaginated({
        organizationId: ctx.organizationId,
        resourceType: "organization",
        limit: 10,
        offset: 0,
      });
      expect(data.some((item) => item.outcome === "success")).toBe(true);
      expect(JSON.stringify(data)).not.toContain("test-private-setting");
      expect(JSON.stringify(data)).toContain("[REDACTED]");
      expect(JSON.stringify(data)).not.toContain(template.icon);
      expect(JSON.stringify(data)).toContain("(set)");
    });
  });

  test("rejects invalid images, duplicate variables, built-in names and privileged templates", async () => {
    const template = makeTemplate();
    for (const invalid of [
      { ...template, runtime: { ...template.runtime, image: "bad image" } },
      {
        ...template,
        runtime: {
          ...template.runtime,
          environment: [
            { key: "DUP", value: "a" },
            { key: "DUP", value: "b" },
          ],
        },
      },
      { ...template, name: "Codex" },
      { ...template, runtime: { ...template.runtime, privileged: true } },
    ])
      expect(
        (
          await save({
            revision: 0,
            templates: [invalid],
            popularAgentOverrides: null,
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (await AgentRuntimeTemplateModel.getSettings(ctx.organizationId))
        .revision,
    ).toBe(0);
  });

  test("legacy availability writes advance the revision and cannot be overwritten by stale template settings", async () => {
    const { default: organizationRoutes } = await import("../organization");
    await ctx.app.register(organizationRoutes);
    const template = makeTemplate();
    expect(
      (
        await save({
          revision: 0,
          templates: [template],
          popularAgentOverrides: null,
        })
      ).statusCode,
    ).toBe(200);
    const updated = { codex: { hidden: true, position: 3 } };
    const legacy = await ctx.app.inject({
      method: "PATCH",
      url: "/api/organization/integration-settings",
      payload: { popularAgentOverrides: updated },
    });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(
      (
        await save({
          revision: 1,
          templates: [template],
          popularAgentOverrides: null,
        })
      ).statusCode,
    ).toBe(409);
    const read = await ctx.app.inject({
      url: "/api/agent-runtime-templates/settings",
    });
    expect(read.json()).toEqual({
      revision: 2,
      templates: [template],
      popularAgentOverrides: updated,
    });
  });

  test("requires organization-settings update permission", async () => {
    ctx.caller = ctx.member;
    expect(
      (
        await save({
          revision: 0,
          templates: [makeTemplate()],
          popularAgentOverrides: null,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await AgentRuntimeTemplateModel.getSettings(ctx.organizationId))
        .templates,
    ).toEqual([]);
  });
});
