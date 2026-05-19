import { eq } from "drizzle-orm";
import { type Mock, type MockInstance, vi } from "vitest";
import db, { schema } from "@/database";
import { McpPresetEntryModel, McpServerModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * Cascade body is `setImmediate(async () => await Model.update(...))`,
 * so we drain real ticks until the loop goes quiet. Fake timers would
 * deadlock against the real PGlite I/O inside that `await`.
 */
async function assertCascadeDidNotFire(spy: MockInstance): Promise<void> {
  const MAX_TICKS = 50;
  for (let i = 0; i < MAX_TICKS; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (spy.mock.calls.length > 0) break;
  }
  expect(spy).not.toHaveBeenCalled();
}

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * The cascade-reinstall gate skips metadata-only edits (currently just
 * `description`) and preserves cascade behavior for everything else.
 */
describe("PUT /api/internal_mcp_catalog/:id — metadata-only edit cascade", () => {
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

  test("description-only PUT does not touch installed mcp_server rows", async ({
    makeMcpServer,
  }) => {
    const catalog = await createCatalog({
      name: "metadata-edit-cascade",
      serverType: "local",
      description: "original description",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
      },
    });

    const installedServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
    });

    const updateSpy = vi.spyOn(McpServerModel, "update");

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: "metadata-edit-cascade",
        serverType: "local",
        description: "rewritten description",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [],
        },
      },
    });

    expect(putResponse.statusCode).toBe(200);

    await assertCascadeDidNotFire(updateSpy);

    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.localInstallationStatus).toBe("idle");
    expect(serverRow.reinstallRequired).toBe(false);
  });

  test("command change (non-metadata) still triggers manual-reinstall path", async ({
    makeMcpServer,
  }) => {
    // Positive control: the gate must not swallow runtime-affecting edits.
    const catalog = await createCatalog({
      name: "runtime-edit-cascade",
      serverType: "local",
      description: "any description",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
      },
    });

    await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
    });

    const updateSpy = vi.spyOn(McpServerModel, "update");

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        name: "runtime-edit-cascade",
        serverType: "local",
        description: "any description",
        localConfig: {
          command: "bun",
          arguments: ["server.js"],
          environment: [],
        },
      },
    });

    expect(putResponse.statusCode).toBe(200);

    expect(updateSpy).toHaveBeenCalled();
    const flaggedForManual = updateSpy.mock.calls.some(
      ([, patch]) =>
        (patch as { reinstallRequired?: boolean }).reinstallRequired === true,
    );
    expect(flaggedForManual).toBe(true);
  });

  test("description-only PUT does not cascade-reinstall children installs (authorName asymmetry regression)", async ({
    makeMcpServer,
  }) => {
    // Regression: parent cascade compares `originalChild` (list shape,
    // no `authorName`) against `Model.update`'s return (has `authorName`).
    // Without `authorName` in IGNORED, every child with an author would
    // auto-reinstall on a description-only parent edit.
    const parent = await createCatalog({
      name: "child-cascade-authorname-regression",
      serverType: "local",
      description: "original",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
      },
    });
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: "child-cascade-prod",
    });
    const childCreate = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${parent.id}/children`,
      payload: { presetEntryId: entry.id, presetFieldValues: {} },
    });
    if (childCreate.statusCode !== 200) {
      throw new Error(
        `child create failed: ${childCreate.statusCode} ${childCreate.body}`,
      );
    }
    const child = childCreate.json();
    const installedOnChild = await makeMcpServer({
      catalogId: child.id,
      ownerId: user.id,
      scope: "personal",
    });

    const updateSpy = vi.spyOn(McpServerModel, "update");

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${parent.id}`,
      payload: {
        name: "child-cascade-authorname-regression",
        serverType: "local",
        description: "rewritten",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [],
        },
      },
    });

    expect(putResponse.statusCode).toBe(200);

    await assertCascadeDidNotFire(updateSpy);

    const [childInstallRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedOnChild.id));
    expect(childInstallRow.localInstallationStatus).toBe("idle");
    expect(childInstallRow.reinstallRequired).toBe(false);
  });

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
});
