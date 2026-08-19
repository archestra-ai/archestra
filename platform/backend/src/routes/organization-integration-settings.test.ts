import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

/**
 * The endpoint carries one thing since per-role access moved to the roles API:
 * the organization's own names for the built-in model providers.
 */
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

  test("persists the organization's provider names", async () => {
    const response = await patch({
      modelProviderOverrides: {
        openai: { displayName: "OpenAI (approved)" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().modelProviderOverrides).toEqual({
      openai: { displayName: "OpenAI (approved)" },
    });
  });

  test("clears every name with null", async () => {
    await patch({ modelProviderOverrides: { openai: { displayName: "X" } } });

    const response = await patch({ modelProviderOverrides: null });

    expect(response.statusCode).toBe(200);
    expect(response.json().modelProviderOverrides).toBeNull();
  });

  test("rejects a provider id that is not part of the catalog", async () => {
    expect(
      (await patch({ modelProviderOverrides: { notaprovider: {} } }))
        .statusCode,
    ).toBe(400);
  });

  // Access lives on roles now, so a `hidden` flag here is a client that has not
  // caught up rather than a customization to accept quietly.
  test("rejects the retired hidden flag", async () => {
    expect(
      (await patch({ modelProviderOverrides: { openai: { hidden: true } } }))
        .statusCode,
    ).toBe(400);
  });

  // A browser tab left open across the upgrade would otherwise appear to gate
  // a channel and silently change nothing.
  test("no longer accepts the retired per-catalog toggles", async () => {
    expect(
      (await patch({ messagingChannelOverrides: { slack: { hidden: true } } }))
        .statusCode,
    ).toBe(400);
  });
});
