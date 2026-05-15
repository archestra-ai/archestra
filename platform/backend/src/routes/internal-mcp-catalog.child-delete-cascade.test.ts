import { type Mock, vi } from "vitest";
import { InternalMcpCatalogModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * Delete-cascade ownership for preset (child) catalog items.
 *
 * Children store the parent's `clientSecretId` / `localConfigSecretId` in
 * their columns for read-path convenience, but those bags are owned by the
 * parent. Only `presetSecretId` is per-row.
 *
 * Deleting a child must therefore delete ONLY the child's `presetSecretId`.
 * Deleting the parent deletes parent-owned bags plus every child's preset
 * bag. A regression here breaks OAuth and local-env secret resolution for
 * the parent and every sibling preset.
 */
describe("Internal MCP Catalog - child delete secret cascade", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("deleting a child preserves the parent's local-config secret bag", async () => {
    const parent = await createCatalog({
      name: "delete-child-keeps-parent-bag",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_KEY",
            type: "secret",
            promptOnInstallation: false,
            value: "parent-owned-secret",
          },
          {
            key: "PRESET_PASSWORD",
            type: "secret",
            promptOnInstallation: false,
            promptOnPreset: true,
          },
        ],
      },
    });

    const parentRaw = await loadRaw(parent.id);
    const parentLocalConfigSecretId = requireSecretId(
      parentRaw.localConfigSecretId,
      "parent local-config secret",
    );

    const child = await createChild(parent.id, {
      childName: "prod",
      presetFieldValues: { PRESET_PASSWORD: "child-only-secret" },
    });

    const childRaw = await loadRaw(child.id);
    expect(childRaw.presetSecretId).toBeTruthy();
    expect(childRaw.localConfigSecretId).toBe(parentLocalConfigSecretId);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${parent.id}/children/${child.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);

    // Parent's local-config secret bag must still resolve — sibling presets
    // and the parent install both depend on it.
    const parentBag = await secretManager().getSecret(
      parentLocalConfigSecretId,
    );
    expect(parentBag).not.toBeNull();
    expect(parentBag?.secret).toEqual({ API_KEY: "parent-owned-secret" });

    // Child's own preset secret bag is gone.
    const childPresetBag = await secretManager().getSecret(
      requireSecretId(childRaw.presetSecretId, "child preset secret"),
    );
    expect(childPresetBag).toBeNull();
  });

  test("deleting the parent removes parent-owned bags plus every child's preset bag", async () => {
    const parent = await createCatalog({
      name: "delete-parent-cleans-everything",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "API_KEY",
            type: "secret",
            promptOnInstallation: false,
            value: "parent-owned-secret",
          },
          {
            key: "PRESET_PASSWORD",
            type: "secret",
            promptOnInstallation: false,
            promptOnPreset: true,
          },
        ],
      },
    });

    const childA = await createChild(parent.id, {
      childName: "a",
      presetFieldValues: { PRESET_PASSWORD: "a-secret" },
    });
    const childB = await createChild(parent.id, {
      childName: "b",
      presetFieldValues: { PRESET_PASSWORD: "b-secret" },
    });

    const parentRaw = await loadRaw(parent.id);
    const childARaw = await loadRaw(childA.id);
    const childBRaw = await loadRaw(childB.id);

    const parentLocalConfigSecretId = requireSecretId(
      parentRaw.localConfigSecretId,
      "parent local-config secret",
    );
    const childAPresetSecretId = requireSecretId(
      childARaw.presetSecretId,
      "child A preset secret",
    );
    const childBPresetSecretId = requireSecretId(
      childBRaw.presetSecretId,
      "child B preset secret",
    );

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${parent.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);

    expect(
      await secretManager().getSecret(parentLocalConfigSecretId),
    ).toBeNull();
    expect(await secretManager().getSecret(childAPresetSecretId)).toBeNull();
    expect(await secretManager().getSecret(childBPresetSecretId)).toBeNull();
  });

  // ===========================================================================
  // Helpers
  // ===========================================================================

  async function createCatalog(payload: Record<string, unknown>): Promise<{
    id: string;
  }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload,
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `createCatalog failed: ${response.statusCode} ${response.body}`,
      );
    }
    return response.json();
  }

  async function createChild(
    parentId: string,
    body: { childName: string; presetFieldValues: Record<string, unknown> },
  ): Promise<{ id: string }> {
    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${parentId}/children`,
      payload: body,
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `createChild failed: ${response.statusCode} ${response.body}`,
      );
    }
    return response.json();
  }

  async function loadRaw(id: string) {
    const row = await InternalMcpCatalogModel.findById(id, {
      expandSecrets: false,
      userId: user.id,
      isAdmin: true,
      organizationId,
    });
    if (!row) throw new Error(`row ${id} not found`);
    return row;
  }

  function requireSecretId(
    value: string | null | undefined,
    label: string,
  ): string {
    if (!value) {
      throw new Error(`Expected ${label} to be present`);
    }
    return value;
  }
});
