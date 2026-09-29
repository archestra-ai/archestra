import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import OrganizationModel from "@/models/organization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: { reinitialize: vi.fn() },
}));

import { chatOpsManager } from "@/agents/chatops/chatops-manager";

describe("PATCH /api/organization/integration-settings", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });

    adminUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(adminUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = adminUser;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organizationId;
    });

    registerAuditLogHook(app);
    const { default: organizationRoutes } = await import("./organization");
    await app.register(organizationRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const patch = (payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: "/api/organization/integration-settings",
      payload,
    });

  test("persists overrides for integration catalogs", async () => {
    const response = await patch({
      modelProviderOverrides: {
        anthropic: { hidden: true },
        openai: { displayName: "OpenAI (approved)" },
      },
      messagingChannelOverrides: { telegram: { hidden: true } },
      knowledgeConnectorOverrides: { dropbox: { hidden: true } },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.modelProviderOverrides).toEqual({
      anthropic: { hidden: true },
      openai: { displayName: "OpenAI (approved)" },
    });
    expect(body.messagingChannelOverrides).toEqual({
      telegram: { hidden: true },
    });
    expect(body.knowledgeConnectorOverrides).toEqual({
      dropbox: { hidden: true },
    });
  });

  test("leaves catalogs the request omits untouched", async () => {
    await patch({ modelProviderOverrides: { anthropic: { hidden: true } } });

    const response = await patch({
      messagingChannelOverrides: { slack: { hidden: true } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().modelProviderOverrides).toEqual({
      anthropic: { hidden: true },
    });
  });

  test("clears a catalog's overrides with null", async () => {
    await patch({ modelProviderOverrides: { anthropic: { hidden: true } } });

    const response = await patch({ modelProviderOverrides: null });

    expect(response.statusCode).toBe(200);
    expect(response.json().modelProviderOverrides).toBeNull();
  });

  test("persists popular agent choices, preserves omitted choices, and restores defaults", async () => {
    const overrides = { codex: { hidden: true }, hermes: { hidden: true } };
    const response = await patch({ popularAgentOverrides: overrides });
    expect(response.statusCode).toBe(200);
    expect(response.json().popularAgentOverrides).toEqual(overrides);
    expect(
      (await OrganizationModel.getById(organizationId))?.popularAgentOverrides,
    ).toEqual(overrides);

    await vi.waitFor(async () => {
      const { data } = await AuditLogModel.findPaginated({
        organizationId,
        resourceType: "organization",
        limit: 10,
        offset: 0,
      });
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        action: "organization.updated",
        outcome: "success",
        before: { popularAgentOverrides: null },
        after: { popularAgentOverrides: overrides },
      });
    });

    const unrelated = await patch({
      knowledgeConnectorOverrides: { dropbox: { hidden: true } },
    });
    expect(unrelated.json().popularAgentOverrides).toEqual(overrides);
    const restored = await patch({ popularAgentOverrides: null });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().popularAgentOverrides).toBeNull();
    expect(restored.json().knowledgeConnectorOverrides).toEqual({
      dropbox: { hidden: true },
    });
  });

  test.each([
    { unknown: { hidden: true } },
    { codex: { hidden: "true" } },
    { codex: { displayName: "Custom name" } },
  ])("rejects invalid popular agent configuration %j", async (popularAgentOverrides) => {
    expect((await patch({ popularAgentOverrides })).statusCode).toBe(400);
    expect(
      (await OrganizationModel.getById(organizationId))?.popularAgentOverrides,
    ).toBeNull();
  });

  // Channels and connectors are toggle-only, so a name there is a mistake
  // rather than a customization the API should silently accept.
  test("rejects a display name on a toggle-only catalog", async () => {
    expect(
      (
        await patch({
          messagingChannelOverrides: { slack: { displayName: "Corp chat" } },
        })
      ).statusCode,
    ).toBe(400);
  });

  test("rejects ids that are not part of a catalog", async () => {
    expect(
      (await patch({ messagingChannelOverrides: { discord: {} } })).statusCode,
    ).toBe(400);
    expect(
      (await patch({ modelProviderOverrides: { notaprovider: {} } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await patch({ knowledgeConnectorOverrides: { carrierpigeon: {} } }))
        .statusCode,
    ).toBe(400);
  });

  test("restarts the ChatOps providers when the channel overrides change", async () => {
    await patch({ messagingChannelOverrides: { slack: { hidden: true } } });

    expect(chatOpsManager.reinitialize).toHaveBeenCalledTimes(1);
  });

  test("does not restart the ChatOps providers for an unrelated catalog", async () => {
    await patch({ modelProviderOverrides: { anthropic: { hidden: true } } });

    expect(chatOpsManager.reinitialize).not.toHaveBeenCalled();
  });
});
