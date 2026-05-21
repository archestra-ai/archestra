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

  test("description-only PUT on a secret-bag catalog does not cascade (expandSecrets asymmetry regression)", async ({
    makeMcpServer,
  }) => {
    // Regression: the parent PUT used to fetch `originalCatalogItem`
    // with the default `expandSecrets: true`, then compared against
    // `Model.update`'s raw return. For rows whose `localConfig` carries
    // a populated env secret bag, the expanded plaintext vs stored
    // ID-ref diff tripped `isMetadataOnlyEdit` and the cascade fired
    // for description-only edits — exactly what this optimization is
    // supposed to skip.
    //
    // We bait the bag by creating a local catalog with a `vault`-typed
    // env var so the create route writes to `localConfigSecretId`. Then
    // we send a desc-only PUT and assert no install was touched.
    const catalog = await createCatalog({
      name: "bag-cascade-regression",
      serverType: "local",
      description: "original",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "MY_SECRET",
            type: "secret",
            value: "secret-value-123",
            sensitive: true,
            promptOnInstallation: false,
          },
        ],
      },
    });

    // Sanity: the create route must have allocated a secret bag for this
    // env var. If it didn't, this test isn't actually exercising the
    // expanded-vs-raw asymmetry it claims to regression-cover.
    const [catalogRow] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    expect(catalogRow.localConfigSecretId).not.toBeNull();

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
        name: "bag-cascade-regression",
        serverType: "local",
        description: "rewritten",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "MY_SECRET",
              type: "secret",
              value: "secret-value-123",
              sensitive: true,
              promptOnInstallation: false,
            },
          ],
        },
      },
    });

    if (putResponse.statusCode !== 200) {
      throw new Error(
        `PUT failed: ${putResponse.statusCode} ${putResponse.body}`,
      );
    }

    await assertCascadeDidNotFire(updateSpy);

    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.localInstallationStatus).toBe("idle");
    expect(serverRow.reinstallRequired).toBe(false);
  });

  test("PUT that adds an OPTIONAL prompted env var does not cascade-reinstall installs", async ({
    makeMcpServer,
  }) => {
    // User-reported regression: adding a per-installation, optional env
    // var to a catalog used to trigger a backend auto-restart even
    // though the change is forward-compatible (existing installs can
    // ignore the new optional field). `cascadeReinstallForCatalog`'s
    // `onlyForwardCompatibleEnvDiff` gate should now short-circuit.
    const catalog = await createCatalog({
      name: "fwd-compat-env-add",
      serverType: "local",
      description: "original",
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
        name: "fwd-compat-env-add",
        serverType: "local",
        description: "original",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "OPTIONAL_HINT",
              type: "plain_text",
              promptOnInstallation: true,
              required: false,
            },
          ],
        },
      },
    });

    if (putResponse.statusCode !== 200) {
      throw new Error(
        `PUT failed: ${putResponse.statusCode} ${putResponse.body}`,
      );
    }

    await assertCascadeDidNotFire(updateSpy);

    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.localInstallationStatus).toBe("idle");
    expect(serverRow.reinstallRequired).toBe(false);
  });

  test("PUT that adds an OPTIONAL userConfig header does not cascade-reinstall installs", async ({
    makeMcpServer,
  }) => {
    // User-reported regression: adding a per-installation optional
    // HEADER via the form's Add Header dialog used to trigger backend
    // auto-restart even though the change is forward-compatible. Same
    // class as the optional env-var case; the gate's
    // `onlyForwardCompatibleEnvDiff` now also covers `userConfig`
    // schema evolution.
    const catalog = await createCatalog({
      name: "fwd-compat-header-add",
      serverType: "remote",
      description: "original",
      serverUrl: "https://example.test/mcp",
      userConfig: {
        existing_header: {
          type: "string",
          title: "x-existing",
          description: "",
          headerName: "x-existing",
          promptOnInstallation: true,
          required: false,
          sensitive: false,
        },
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
        name: "fwd-compat-header-add",
        serverType: "remote",
        description: "original",
        serverUrl: "https://example.test/mcp",
        userConfig: {
          existing_header: {
            type: "string",
            title: "x-existing",
            description: "",
            headerName: "x-existing",
            promptOnInstallation: true,
            required: false,
            sensitive: false,
          },
          new_optional_header: {
            type: "string",
            title: "x-new-optional",
            description: "",
            headerName: "x-new-optional",
            promptOnInstallation: true,
            required: false,
            sensitive: false,
          },
        },
      },
    });

    if (putResponse.statusCode !== 200) {
      throw new Error(
        `PUT failed: ${putResponse.statusCode} ${putResponse.body}`,
      );
    }

    await assertCascadeDidNotFire(updateSpy);

    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.localInstallationStatus).toBe("idle");
    expect(serverRow.reinstallRequired).toBe(false);
  });

  test("rotation + re-prompt edit in the same PUT marks installs for manual reinstall (forceAutoRestart must not preempt re-prompt)", async ({
    makeMcpServer,
  }) => {
    // Regression: when a single PUT both rotates a non-prompted secret
    // env var value AND adds a re-prompt-requiring schema change (a
    // new REQUIRED prompted env var), the previous `forceAutoRestart`
    // override unconditionally skipped `requiresNewUserInputForReinstall`
    // — so pods were auto-restarted with the rotated secret but
    // without the newly-required prompted value. Manual path must win:
    // re-prompt blocks any auto-restart variant.
    const catalog = await createCatalog({
      name: "rotate-plus-reprompt",
      serverType: "local",
      description: "original",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "DB_PASSWORD",
            type: "secret",
            value: "old-secret",
            promptOnInstallation: false,
            required: false,
          },
        ],
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
        name: "rotate-plus-reprompt",
        serverType: "local",
        description: "original",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              // Rotated value — triggers `catalogSharedSecretValuesRotated`.
              key: "DB_PASSWORD",
              type: "secret",
              value: "new-secret",
              promptOnInstallation: false,
              required: false,
            },
            {
              // Newly-required prompted env var — triggers
              // `promptedEnvVarsChanged → requiresNewUserInputForReinstall`.
              key: "NEW_REQUIRED",
              type: "plain_text",
              promptOnInstallation: true,
              required: true,
            },
          ],
        },
      },
    });

    if (putResponse.statusCode !== 200) {
      throw new Error(
        `PUT failed: ${putResponse.statusCode} ${putResponse.body}`,
      );
    }

    // Manual path fired: server marked reinstallRequired, no auto
    // restart status churn.
    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.reinstallRequired).toBe(true);
    expect(serverRow.localInstallationStatus).toBe("idle");

    const updateCalls = updateSpy.mock.calls.filter(
      ([id]) => id === installedServer.id,
    );
    // Exactly one update — the reinstallRequired flag. No "pending" /
    // "success" transitions from the auto-restart branch.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toEqual({ reinstallRequired: true });
  });

  test("userConfig-only PUT on a local catalog with a localConfigSecretId does not falsely trigger forceAutoRestart", async ({
    makeMcpServer,
  }) => {
    // Regression: the local-config secret block runs whenever the
    // request supplies EITHER `localConfig` OR `userConfig`. When the
    // request only touches `userConfig`, we never iterate the env-var /
    // image-pull-secret loops, so `secretEnvVars` stays empty. The
    // "dropped key" rotation detection used to flag every existing
    // bag key as dropped — falsely setting `catalogSharedSecretValuesRotated`
    // and forcing the auto path for an edit the forward-compat gate
    // should skip.
    const catalog = await createCatalog({
      name: "userconfig-only-on-bag-catalog",
      serverType: "local",
      description: "original",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "DB_PASSWORD",
            type: "secret",
            value: "supersecret",
            promptOnInstallation: false,
            required: false,
          },
        ],
      },
      userConfig: {
        existing_header: {
          type: "string",
          title: "x-existing",
          description: "",
          headerName: "x-existing",
          promptOnInstallation: true,
          required: false,
          sensitive: false,
        },
      },
    });

    const installedServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
    });

    const updateSpy = vi.spyOn(McpServerModel, "update");

    // Userconfig-only edit: add an optional header. localConfig
    // intentionally omitted from the body — the existing secret bag
    // (`DB_PASSWORD`) must not be read as "all keys dropped."
    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        userConfig: {
          existing_header: {
            type: "string",
            title: "x-existing",
            description: "",
            headerName: "x-existing",
            promptOnInstallation: true,
            required: false,
            sensitive: false,
          },
          new_optional_header: {
            type: "string",
            title: "x-new-optional",
            description: "",
            headerName: "x-new-optional",
            promptOnInstallation: true,
            required: false,
            sensitive: false,
          },
        },
      },
    });

    if (putResponse.statusCode !== 200) {
      throw new Error(
        `PUT failed: ${putResponse.statusCode} ${putResponse.body}`,
      );
    }

    await assertCascadeDidNotFire(updateSpy);

    const [serverRow] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, installedServer.id));
    expect(serverRow.localInstallationStatus).toBe("idle");
    expect(serverRow.reinstallRequired).toBe(false);
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
