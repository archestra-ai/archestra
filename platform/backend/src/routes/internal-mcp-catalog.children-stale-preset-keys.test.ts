import { type Mock, vi } from "vitest";
import { InternalMcpCatalogModel, McpPresetEntryModel } from "@/models";
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
 * Reproduces the user-reported bug:
 *
 *   1. Edit preset "staging", set DB_PASSWORD = "passwordstaging3"
 *   2. Delete installation
 *   3. Reinstall, choose "staging" preset
 *   4. Fill any other env
 *   5. Check pod env in Shell — DB_PASSWORD is NOT "passwordstaging3"
 *
 * Why the new password value never lands on the catalog row: when a
 * parent's field scope flips from `promptOnPreset: true` to non-preset
 * (admin edits the catalog), the cascade syncs the parent's localConfig
 * template down to children but does NOT scrub their preset_field_values
 * jsonb. The child row keeps an orphaned entry for the now-non-preset key.
 *
 * The next time the user opens the preset editor:
 *   - Local state initializes from `preset.presetFieldValues` → carries the orphan.
 *   - User types a value into a still-valid preset field (DB_PASSWORD).
 *   - Save sends the entire local state (orphan + new value) via PATCH.
 *   - `validateFieldValuesAgainstCatalog` rejects the whole payload because
 *     the orphan key is not in the parent's currently-preset-scoped keys
 *     → 400 "Fields not configured for preset overrides: <orphan>".
 *   - Save silently fails. The new DB_PASSWORD value never reaches the
 *     secret bag. The next install reads the stale value.
 *
 * This test pins the DESIRED behavior at the route layer — PATCH must
 * tolerate orphaned keys (silently dropping them is fine) and persist any
 * still-valid field values from the same payload. Multiple fix shapes
 * satisfy this contract:
 *   (a) backend validator silently drops keys that are no longer
 *       preset-scoped on the parent;
 *   (b) backend cascade scrubs orphans from children when a parent's
 *       field scope flips (then the orphan never reaches the editor in
 *       the first place);
 *   (c) frontend filters the save payload to currently-preset-scoped keys.
 *
 * Either (a) alone or (b) alone makes this test green; together they're
 * defense-in-depth. (c) cannot be exercised here (it's a frontend concern).
 */
describe("PATCH /api/internal_mcp_catalog/:catalogId/children/:childId — tolerates stale preset keys", () => {
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

  test("editing a preset persists the new value even when the payload still carries keys from a former preset field", async () => {
    // ── 1. Parent starts with TWO preset-scoped envs.
    const parent = await createCatalog({
      name: "stale-keys-parent",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "DIALECT_PACKAGES",
            type: "plain_text",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
          {
            key: "DB_PASSWORD",
            type: "secret",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    // ── 2. Create the staging child preset with values for both.
    const child = await createChild(parent.id, {
      childName: "staging",
      presetFieldValues: {
        DIALECT_PACKAGES: "psycopg2-binary,pymysql",
        DB_PASSWORD: "old-password",
      },
    });

    // ── 3. Admin edits the parent: DIALECT_PACKAGES is no longer
    //    preset-scoped (becomes a static env with a fixed value).
    //    The cascade syncs the new template to children.
    const flipResponse = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${parent.id}`,
      payload: {
        ...stripCascadeIgnored(parent),
        localConfig: {
          ...parent.localConfig,
          environment: [
            {
              key: "DIALECT_PACKAGES",
              type: "plain_text",
              promptOnInstallation: false,
              // promptOnPreset removed → no longer a preset-scoped field
              required: false,
              value: "psycopg2-binary",
            },
            // DB_PASSWORD stays preset-scoped
            {
              key: "DB_PASSWORD",
              type: "secret",
              promptOnInstallation: false,
              promptOnPreset: true,
              required: false,
            },
          ],
        },
      },
    });
    expect(flipResponse.statusCode).toBe(200);

    // ── 4. Confirm the orphan exists on the child row (this is the
    //    real-world precondition that the editor would carry into local
    //    state and re-send on save).
    const childAfterFlip = await loadRaw(child.id);
    expect(childAfterFlip.presetFieldValues).toHaveProperty(
      "DIALECT_PACKAGES",
      "psycopg2-binary,pymysql",
    );

    // ── 5. The user opens the editor (loads orphan + valid keys into
    //    local state), types a NEW DB_PASSWORD, and clicks Save. The
    //    frontend posts the full local state — which includes the
    //    orphaned DIALECT_PACKAGES.
    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/api/internal_mcp_catalog/${parent.id}/children/${child.id}`,
      payload: {
        presetFieldValues: {
          DIALECT_PACKAGES: "psycopg2-binary,pymysql", // ← orphan from former scope
          DB_PASSWORD: "passwordstaging3", // ← the value the user typed
        },
      },
    });

    // ── 6. The PATCH must succeed. (Today: 400 with
    //     "Fields not configured for preset overrides: DIALECT_PACKAGES".)
    expect(patchResponse.statusCode).toBe(200);

    // ── 7. The new DB_PASSWORD must have landed in the secret bag.
    //     Without this, the next install reads the stale value and the
    //     pod's env shows the old password — exactly the user-reported
    //     symptom in step 6 of the repro.
    const childAfterPatch = await loadRaw(child.id);
    const presetSecretId = childAfterPatch.presetSecretId;
    if (!presetSecretId) throw new Error("expected presetSecretId");

    const bag = await secretManager().getSecret(presetSecretId);
    expect(bag?.secret).toMatchObject({ DB_PASSWORD: "passwordstaging3" });
  });

  // ===========================================================================
  // Helpers
  // ===========================================================================

  async function createCatalog(payload: Record<string, unknown>): Promise<{
    id: string;
    name: string;
    serverType: string;
    localConfig: Record<string, unknown>;
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
    const entry = await McpPresetEntryModel.create({
      organizationId,
      name: body.childName,
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${parentId}/children`,
      payload: {
        presetEntryId: entry.id,
        presetFieldValues: body.presetFieldValues,
      },
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
});

/**
 * The PUT route's body schema rejects keys that are locked-after-creation
 * (organizationId, authorId, multitenant, parentCatalogItemId). Strip them
 * from a previously-fetched catalog row before re-posting it as a PUT body.
 */
function stripCascadeIgnored(parent: Record<string, unknown>) {
  const {
    id: _id,
    organizationId: _o,
    authorId: _a,
    multitenant: _m,
    parentCatalogItemId: _p,
    childName: _c,
    createdAt: _ca,
    updatedAt: _u,
    ...rest
  } = parent as Record<string, unknown>;
  return rest;
}
