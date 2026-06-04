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
 * Storage-routing matrix: confirms which values land in jsonb columns vs. the
 * `secret` table for every combination of (env vs header) × (static / per-preset /
 * per-user) × (secret / non-secret).
 *
 * Conventions:
 *   - "env" = `localConfig.environment[i]` (key flag: `type === "secret"`).
 *   - "header" = `userConfig[field]` with `headerName` set (key flag: `sensitive`).
 *   - Static = `promptOnInstallation: false`, no `promptOnPreset`.
 *   - Per-preset = `promptOnPreset: true`.
 *   - Per-user = `promptOnInstallation: true`.
 */
describe("Internal MCP Catalog - Storage Routing", () => {
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

  // ===========================================================================
  // ENV VARS — localConfig.environment[]
  // ===========================================================================

  describe("env vars", () => {
    test("static + non-secret → inline in local_config jsonb, no secret row", async () => {
      const created = await createCatalog({
        name: "env-static-plain",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "LOG_LEVEL",
              type: "plain_text",
              promptOnInstallation: false,
              value: "debug",
            },
          ],
        },
      });

      const row = await loadRaw(created.id);
      expect(row.localConfigSecretId).toBeNull();
      expect(row.localConfig?.environment?.[0]).toMatchObject({
        key: "LOG_LEVEL",
        type: "plain_text",
        value: "debug",
      });
    });

    test("static + secret → value stripped from jsonb, stored in localConfigSecret", async () => {
      const created = await createCatalog({
        name: "env-static-secret",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "API_KEY",
              type: "secret",
              promptOnInstallation: false,
              value: "super-secret-value",
            },
          ],
        },
      });

      const row = await loadRaw(created.id);
      const { localConfigSecretId } = row;
      if (!localConfigSecretId) throw new Error("expected localConfigSecretId");
      expect(row.localConfig?.environment?.[0].value).toBeUndefined();

      const bag = await secretManager().getSecret(localConfigSecretId);
      expect(bag?.secret).toEqual({ API_KEY: "super-secret-value" });
    });

    test("per-preset + non-secret → inline in preset_field_values jsonb, no preset secret row", async () => {
      const parent = await createCatalog({
        name: "env-preset-plain-parent",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "REGION",
              type: "plain_text",
              promptOnInstallation: false,
              promptOnPreset: true,
            },
          ],
        },
      });

      const child = await createChild(parent.id, {
        childName: "us-east",
        presetFieldValues: { REGION: "us-east-1" },
      });

      const row = await loadRaw(child.id);
      expect(row.presetSecretId).toBeNull();
      expect(row.presetFieldValues).toEqual({ REGION: "us-east-1" });
    });

    test("per-preset + secret → value stripped from preset_field_values, stored in presetSecret", async () => {
      const parent = await createCatalog({
        name: "env-preset-secret-parent",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "DB_PASSWORD",
              type: "secret",
              promptOnInstallation: false,
              promptOnPreset: true,
            },
          ],
        },
      });

      const child = await createChild(parent.id, {
        childName: "prod",
        presetFieldValues: { DB_PASSWORD: "rotate-me-1" },
      });

      const row = await loadRaw(child.id);
      const { presetSecretId } = row;
      if (!presetSecretId) throw new Error("expected presetSecretId");
      expect(row.presetFieldValues).toEqual({});

      const bag = await secretManager().getSecret(presetSecretId);
      expect(bag?.secret).toEqual({ DB_PASSWORD: "rotate-me-1" });
    });

    test("per-user (prompt on installation) + secret → catalog row carries the schema only, no value anywhere", async () => {
      const created = await createCatalog({
        name: "env-per-user-secret",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "USER_TOKEN",
              type: "secret",
              promptOnInstallation: true,
              required: true,
            },
          ],
        },
      });

      const row = await loadRaw(created.id);
      expect(row.localConfigSecretId).toBeNull();
      expect(row.presetSecretId).toBeNull();
      expect(row.localConfig?.environment?.[0]).toMatchObject({
        key: "USER_TOKEN",
        type: "secret",
        promptOnInstallation: true,
      });
      expect(row.localConfig?.environment?.[0].value).toBeUndefined();
    });

    test("per-user + non-secret → catalog row carries the schema only, no value anywhere", async () => {
      const created = await createCatalog({
        name: "env-per-user-plain",
        serverType: "local",
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "WORKSPACE",
              type: "plain_text",
              promptOnInstallation: true,
              required: true,
            },
          ],
        },
      });

      const row = await loadRaw(created.id);
      expect(row.localConfigSecretId).toBeNull();
      expect(row.localConfig?.environment?.[0].value).toBeUndefined();
    });
  });

  // ===========================================================================
  // HEADERS — userConfig[field] with headerName
  // ===========================================================================

  describe("headers", () => {
    test("static + non-sensitive → inline in user_config jsonb default, no secret row", async () => {
      const created = await createCatalog({
        name: "header-static-plain",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          tenant_id: {
            type: "string",
            title: "Tenant",
            description: "Tenant header",
            required: false,
            sensitive: false,
            headerName: "x-tenant-id",
            promptOnInstallation: false,
            default: "tenant-42",
          },
        },
      });

      const row = await loadRaw(created.id);
      expect(row.clientSecretId).toBeNull();
      expect(row.localConfigSecretId).toBeNull();
      expect(row.userConfig?.tenant_id.default).toBe("tenant-42");
    });

    test("static + sensitive → rejected at validation (sensitive static header is not allowed)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "header-static-sensitive",
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            api_key: {
              type: "string",
              title: "API Key",
              description: "Static sensitive",
              required: true,
              sensitive: true,
              headerName: "x-api-key",
              promptOnInstallation: false,
              default: "should-be-rejected",
            },
          },
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          message: expect.stringContaining(
            "Static header-mapped userConfig fields cannot be marked sensitive",
          ),
        },
      });
    });

    test("per-preset + non-sensitive → inline in preset_field_values, no preset secret row", async () => {
      const parent = await createCatalog({
        name: "header-preset-plain-parent",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          tenant_id: {
            type: "string",
            title: "Tenant",
            description: "Per-preset tenant",
            required: false,
            sensitive: false,
            headerName: "x-tenant-id",
            promptOnPreset: true,
          },
        },
      });

      const child = await createChild(parent.id, {
        childName: "acme",
        presetFieldValues: { tenant_id: "acme-corp" },
      });

      const row = await loadRaw(child.id);
      expect(row.presetSecretId).toBeNull();
      expect(row.presetFieldValues).toEqual({ tenant_id: "acme-corp" });
    });

    test("per-preset + sensitive → stripped from preset_field_values, stored in presetSecret", async () => {
      const parent = await createCatalog({
        name: "header-preset-sensitive-parent",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          api_key: {
            type: "string",
            title: "API Key",
            description: "Per-preset secret",
            required: true,
            sensitive: true,
            headerName: "x-api-key",
            promptOnPreset: true,
          },
        },
      });

      const child = await createChild(parent.id, {
        childName: "acme",
        presetFieldValues: { api_key: "acme-key-1" },
      });

      const row = await loadRaw(child.id);
      const { presetSecretId } = row;
      if (!presetSecretId) throw new Error("expected presetSecretId");
      expect(row.presetFieldValues).toEqual({});

      const bag = await secretManager().getSecret(presetSecretId);
      expect(bag?.secret).toEqual({ api_key: "acme-key-1" });
    });

    test("per-user + sensitive → catalog row carries the schema only, no value anywhere", async () => {
      const created = await createCatalog({
        name: "header-per-user-sensitive",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Per-caller token",
            required: true,
            sensitive: true,
            headerName: "authorization",
            promptOnInstallation: true,
          },
        },
      });

      const row = await loadRaw(created.id);
      expect(row.clientSecretId).toBeNull();
      expect(row.localConfigSecretId).toBeNull();
      expect(row.presetSecretId).toBeNull();
      expect(row.userConfig?.access_token).toMatchObject({
        sensitive: true,
        headerName: "authorization",
        promptOnInstallation: true,
      });
      expect(row.userConfig?.access_token.default).toBeUndefined();
    });

    test("per-user + non-sensitive → catalog row carries the schema only, no value anywhere", async () => {
      const created = await createCatalog({
        name: "header-per-user-plain",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          tenant_id: {
            type: "string",
            title: "Tenant",
            description: "Per-caller tenant",
            required: false,
            sensitive: false,
            headerName: "x-tenant-id",
            promptOnInstallation: true,
          },
        },
      });

      const row = await loadRaw(created.id);
      expect(row.localConfigSecretId).toBeNull();
      expect(row.userConfig?.tenant_id.default).toBeUndefined();
    });

    test("flipping a per-preset header from non-sensitive to sensitive moves the value from preset_field_values jsonb into the preset secret bag on the next child PATCH", async () => {
      // Test 2 (toggle on re-save) — once an admin flips the field's
      // `sensitive` flag in the parent's userConfig, the next time a child
      // preset is edited and resupplies the value, the partition function
      // routes it to the secret bag and the wholesale `presetFieldValues`
      // replace drops the now-orphan plaintext copy from the jsonb.
      const parentName = "header-flip-sensitivity-parent";
      const parent = await createCatalog({
        name: parentName,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          api_key: {
            type: "string",
            title: "API Key",
            description: "Per-preset key (initially plaintext)",
            required: false,
            sensitive: false,
            headerName: "x-api-key",
            promptOnPreset: true,
          },
        },
      });

      // Before the flip: value lives in preset_field_values jsonb.
      const child = await createChild(parent.id, {
        childName: "acme",
        presetFieldValues: { api_key: "plain-acme-key" },
      });
      let row = await loadRaw(child.id);
      expect(row.presetSecretId).toBeNull();
      expect(row.presetFieldValues).toEqual({ api_key: "plain-acme-key" });

      // Admin flips the parent userConfig field to sensitive.
      const flip = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${parent.id}`,
        payload: {
          name: parentName,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            api_key: {
              type: "string",
              title: "API Key",
              description: "Per-preset key (now sensitive)",
              required: false,
              sensitive: true,
              headerName: "x-api-key",
              promptOnPreset: true,
            },
          },
        },
      });
      expect(flip.statusCode).toBe(200);

      // The parent PUT cascade now re-partitions every child's already-
      // stored preset values against the updated schema, so the child's
      // value has migrated from plaintext jsonb to the secret bag
      // immediately — no PATCH round-trip required.
      row = await loadRaw(child.id);
      expect(row.presetFieldValues).toEqual({});
      const presetSecretIdAfterFlip = row.presetSecretId;
      if (!presetSecretIdAfterFlip) {
        throw new Error(
          "expected presetSecretId on child immediately after parent flip",
        );
      }
      const bagAfterFlip = await secretManager().getSecret(
        presetSecretIdAfterFlip,
      );
      expect(bagAfterFlip?.secret).toEqual({ api_key: "plain-acme-key" });

      // Admin re-saves the child preset, rotating the value.
      const patch = await app.inject({
        method: "PATCH",
        url: `/api/internal_mcp_catalog/${parent.id}/children/${child.id}`,
        payload: {
          presetFieldValues: { api_key: "rotated-acme-key" },
        },
      });
      expect(patch.statusCode).toBe(200);

      // After re-save: rotated value still lives in the secret bag, jsonb
      // still empty.
      row = await loadRaw(child.id);
      const { presetSecretId } = row;
      if (!presetSecretId) throw new Error("expected presetSecretId");
      expect(row.presetFieldValues).toEqual({});

      const bag = await secretManager().getSecret(presetSecretId);
      expect(bag?.secret).toEqual({ api_key: "rotated-acme-key" });
    });
  });

  // ===========================================================================
  // Root-route secret partitioning matrix
  // ===========================================================================
  //
  // Whenever the create / update route accepts `presetFieldValues` alongside
  // a userConfig that declares sensitive preset-scoped fields, the route
  // must invoke `partitionPresetFieldValuesAndUpsertSecrets` so the value
  // lands in `preset_secret_id`'s bag rather than the plaintext
  // `preset_field_values` jsonb. Both POST (create) and PUT (update) must
  // partition; before this matrix existed, only PUT did, so a single root
  // POST could persist a sensitive preset value in plaintext.

  describe("headers — root-route secret partitioning matrix", () => {
    type Row = {
      route: "POST" | "PUT";
      sensitive: boolean;
      description: string;
    };

    const rows: Row[] = [
      {
        route: "POST",
        sensitive: false,
        description:
          "POST root + presetFieldValues + non-sensitive → value in plaintext jsonb, no secret row",
      },
      {
        route: "POST",
        sensitive: true,
        description:
          "POST root + presetFieldValues + sensitive → value in secret bag, jsonb empty",
      },
      {
        route: "PUT",
        sensitive: false,
        description:
          "PUT root + presetFieldValues + non-sensitive → value in plaintext jsonb, no secret row",
      },
      {
        route: "PUT",
        sensitive: true,
        description:
          "PUT root + presetFieldValues + sensitive → value in secret bag, jsonb empty",
      },
    ];

    test("PUT that introduces a new sensitive preset userConfig field + supplies its value in the SAME request routes the value to the secret bag (not plaintext jsonb)", async () => {
      // Regression for the second-order gap: PUT used to partition against
      // `originalCatalogItem.userConfig`, so if a single PUT both flipped a
      // userConfig field to sensitive AND supplied a value for it, the
      // partition saw the OLD (non-sensitive) userConfig and routed the
      // value into plaintext jsonb. The fix is to partition against the
      // *effective* userConfig — the incoming one when provided, otherwise
      // the row's existing one.
      const FIELD_KEY = "combined_put_key";
      const VALUE = "combined-put-value";
      // Step 1: create a baseline catalog with NO userConfig
      const baselineName = "header-combined-put-baseline";
      const baseline = await createCatalog({
        name: baselineName,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
      });

      // Step 2: PUT it with BOTH new userConfig (sensitive preset) AND
      // presetFieldValues in one request.
      const putResponse = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${baseline.id}`,
        payload: {
          name: baselineName,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            [FIELD_KEY]: {
              type: "string",
              title: "Combined PUT field",
              description: "newly-introduced sensitive preset field",
              required: false,
              sensitive: true,
              headerName: "x-combined-put",
              promptOnPreset: true,
              promptOnInstallation: false,
            },
          },
          presetFieldValues: { [FIELD_KEY]: VALUE },
        },
      });
      expect(putResponse.statusCode).toBe(200);

      // Step 3: value must live in the secret bag, NOT in plaintext jsonb.
      const row = await loadRaw(baseline.id);
      expect(row.presetFieldValues).toEqual({});
      const { presetSecretId } = row;
      if (!presetSecretId) {
        throw new Error(
          "expected presetSecretId to be set for sensitive preset value",
        );
      }
      const bag = await secretManager().getSecret(presetSecretId);
      expect(bag?.secret).toEqual({ [FIELD_KEY]: VALUE });
    });

    test.each(rows)("$description", async ({ route, sensitive }) => {
      const VALUE = "matrix-test-value";
      const FIELD_KEY = "api_key";
      const userConfig = {
        [FIELD_KEY]: {
          type: "string",
          title: "API Key",
          description: "Per-preset",
          required: false,
          sensitive,
          headerName: "x-api-key",
          promptOnPreset: true,
          promptOnInstallation: false,
        },
      };
      const baseName = `header-root-partition-${route.toLowerCase()}-${sensitive ? "sens" : "plain"}`;

      let catalogId: string;
      if (route === "POST") {
        const created = await createCatalog({
          name: baseName,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig,
          presetFieldValues: { [FIELD_KEY]: VALUE },
        });
        catalogId = created.id;
      } else {
        // PUT path: create the parent first WITHOUT presetFieldValues, then
        // update it with the value. Exercises the existing PUT partition
        // path as a control row alongside the POST coverage.
        const created = await createCatalog({
          name: baseName,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig,
        });
        catalogId = created.id;
        const putResponse = await app.inject({
          method: "PUT",
          url: `/api/internal_mcp_catalog/${catalogId}`,
          payload: {
            name: baseName,
            serverType: "remote",
            serverUrl: "https://example.com/mcp",
            userConfig,
            presetFieldValues: { [FIELD_KEY]: VALUE },
          },
        });
        expect(putResponse.statusCode).toBe(200);
      }

      const row = await loadRaw(catalogId);
      if (sensitive) {
        // Value MUST be in the secret bag, NOT in plaintext jsonb.
        expect(row.presetFieldValues).toEqual({});
        const { presetSecretId } = row;
        if (!presetSecretId) {
          throw new Error("expected presetSecretId to be set for sensitive");
        }
        const bag = await secretManager().getSecret(presetSecretId);
        expect(bag?.secret).toEqual({ [FIELD_KEY]: VALUE });
      } else {
        // Non-sensitive stays inline in jsonb, no secret row created.
        expect(row.presetFieldValues).toEqual({ [FIELD_KEY]: VALUE });
        expect(row.presetSecretId).toBeNull();
      }
    });
  });

  // ===========================================================================
  // Declassification — sensitive → non-sensitive flips drop the stale secret
  // ===========================================================================
  //
  // When an admin flips a preset-scoped header from sensitive → non-sensitive,
  // the partition function used to leave the previously-stored value sitting
  // in `preset_secret_id`'s bag. The catalog read path merges that bag *over*
  // the plaintext `preset_field_values`, so the stale secret kept leaking out
  // on every outgoing request — even after the admin re-entered a
  // non-sensitive replacement value in the form.
  //
  // The contract: any key in the secret bag whose field is no longer flagged
  // sensitive (per the now-current userConfig) must be dropped at partition
  // time.

  describe("declassifying a preset header clears its stale secret value", () => {
    test("flipping sensitive → non-sensitive removes the key from preset_secret_id's bag and persists the new value in plaintext jsonb", async () => {
      const FIELD_KEY = "declassify_key";
      const SENSITIVE_VALUE = "was-sensitive-value";
      const PLAIN_VALUE = "now-plain-value";
      const baseName = "header-declassify";

      // Step 1: create a catalog with the field marked sensitive AND
      // supply a value — value lands in the secret bag.
      const created = await createCatalog({
        name: baseName,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          [FIELD_KEY]: {
            type: "string",
            title: "Declassify",
            description: "",
            required: false,
            sensitive: true,
            headerName: "x-declassify",
            promptOnPreset: true,
            promptOnInstallation: false,
          },
        },
        presetFieldValues: { [FIELD_KEY]: SENSITIVE_VALUE },
      });
      let row = await loadRaw(created.id);
      const originalSecretId = row.presetSecretId;
      if (!originalSecretId) {
        throw new Error("expected presetSecretId after initial create");
      }
      expect(row.presetFieldValues).toEqual({});
      const initialBag = await secretManager().getSecret(originalSecretId);
      expect(initialBag?.secret).toEqual({ [FIELD_KEY]: SENSITIVE_VALUE });

      // Step 2: admin flips the field to non-sensitive AND re-enters a
      // new value through the same PUT.
      const flipResponse = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${created.id}`,
        payload: {
          name: baseName,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            [FIELD_KEY]: {
              type: "string",
              title: "Declassify",
              description: "",
              required: false,
              sensitive: false,
              headerName: "x-declassify",
              promptOnPreset: true,
              promptOnInstallation: false,
            },
          },
          presetFieldValues: { [FIELD_KEY]: PLAIN_VALUE },
        },
      });
      expect(flipResponse.statusCode).toBe(200);

      // Step 3: the new value must land in plaintext jsonb, AND the secret
      // bag must no longer contain the stale sensitive value. Otherwise the
      // catalog read path's merge would surface the stale secret on top of
      // the plaintext, and outgoing headers would still carry the old value.
      row = await loadRaw(created.id);
      expect(row.presetFieldValues).toEqual({ [FIELD_KEY]: PLAIN_VALUE });
      if (row.presetSecretId !== null) {
        const finalBag = await secretManager().getSecret(row.presetSecretId);
        expect(finalBag?.secret ?? {}).not.toHaveProperty(FIELD_KEY);
      }
    });

    test("when the LAST sensitive field is declassified, the row's presetSecretId pointer is cleared (UI must not see <set> from an empty bag)", async () => {
      // The preset list / install dialog UI keys on `presetSecretId != null`
      // to decide whether to render "<set>" badges and to skip required-
      // prompts for preset-scoped secret fields. If we leave the pointer
      // non-null after declassifying every sensitive key (bag now empty),
      // the UI lies: it shows "<set>" for fields that no longer carry any
      // secret value, and the install dialog skips prompts that should now
      // be required.
      const FIELD_KEY = "only_sensitive_key";
      const baseName = "header-declassify-last-key";

      const created = await createCatalog({
        name: baseName,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          [FIELD_KEY]: {
            type: "string",
            title: "Only sensitive",
            description: "",
            required: false,
            sensitive: true,
            headerName: "x-only-sens",
            promptOnPreset: true,
            promptOnInstallation: false,
          },
        },
        presetFieldValues: { [FIELD_KEY]: "secret-val" },
      });
      const initialRow = await loadRaw(created.id);
      expect(initialRow.presetSecretId).not.toBeNull();

      // Flip the only sensitive field to non-sensitive. Don't supply a new
      // value in the same PUT — exercises the "bag becomes fully empty"
      // branch (no incoming secret value to backfill).
      const flipResponse = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${created.id}`,
        payload: {
          name: baseName,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            [FIELD_KEY]: {
              type: "string",
              title: "Only sensitive",
              description: "",
              required: false,
              sensitive: false,
              headerName: "x-only-sens",
              promptOnPreset: true,
              promptOnInstallation: false,
            },
          },
          presetFieldValues: { [FIELD_KEY]: "now-plain" },
        },
      });
      expect(flipResponse.statusCode).toBe(200);

      const row = await loadRaw(created.id);
      // Pointer must be cleared so the UI doesn't think any secret preset
      // values are set on this row.
      expect(row.presetSecretId).toBeNull();
      expect(row.presetFieldValues).toEqual({ [FIELD_KEY]: "now-plain" });
    });
  });

  // ===========================================================================
  // Schema-only sensitivity flips repartition stored preset values
  // ===========================================================================
  //
  // When a PUT updates ONLY userConfig (no presetFieldValues in the same
  // request) and the change flips a preset-scoped field's `sensitive` flag,
  // the previously-stored value is now in the wrong place: a non-sensitive
  // → sensitive flip leaves the value in plaintext preset_field_values
  // jsonb, and a sensitive → non-sensitive flip leaves a stale value in
  // preset_secret_id's bag that the catalog read path's "merge bag over
  // jsonb" still surfaces. The PUT must repartition the existing values
  // — both on the parent row and on each child row that's cascaded — so
  // each stored value ends up in the storage location its current
  // sensitive flag mandates.

  describe("schema-only sensitivity flips repartition stored preset values", () => {
    test("PUT flipping userConfig non-sensitive → sensitive (no presetFieldValues in request) moves the stored value from plaintext jsonb into the secret bag on the PARENT row", async () => {
      const FIELD_KEY = "schema_flip_key";
      const VALUE = "stored-before-flip";
      const name = "header-schema-flip-parent-up";

      // Step 1: create with non-sensitive + value → value in jsonb
      const created = await createCatalog({
        name,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          [FIELD_KEY]: {
            type: "string",
            title: "X",
            description: "",
            required: false,
            sensitive: false,
            headerName: "x-flip",
            promptOnPreset: true,
            promptOnInstallation: false,
          },
        },
        presetFieldValues: { [FIELD_KEY]: VALUE },
      });
      let row = await loadRaw(created.id);
      expect(row.presetFieldValues).toEqual({ [FIELD_KEY]: VALUE });
      expect(row.presetSecretId).toBeNull();

      // Step 2: PUT new userConfig flipping sensitive=true. NO
      // presetFieldValues — the admin only toggled the schema flag.
      const flip = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${created.id}`,
        payload: {
          name,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            [FIELD_KEY]: {
              type: "string",
              title: "X",
              description: "",
              required: false,
              sensitive: true,
              headerName: "x-flip",
              promptOnPreset: true,
              promptOnInstallation: false,
            },
          },
        },
      });
      expect(flip.statusCode).toBe(200);

      // Step 3: value must have migrated jsonb → bag
      row = await loadRaw(created.id);
      expect(row.presetFieldValues).toEqual({});
      const { presetSecretId } = row;
      if (!presetSecretId) {
        throw new Error("expected presetSecretId after sensitivity flip");
      }
      const bag = await secretManager().getSecret(presetSecretId);
      expect(bag?.secret).toEqual({ [FIELD_KEY]: VALUE });
    });

    test("PUT flipping userConfig sensitive → non-sensitive (no presetFieldValues in request) moves the stored value from the secret bag into plaintext jsonb on the PARENT row", async () => {
      const FIELD_KEY = "schema_flip_key";
      const VALUE = "stored-before-declassify";
      const name = "header-schema-flip-parent-down";

      // Step 1: create with sensitive + value → value in bag
      const created = await createCatalog({
        name,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          [FIELD_KEY]: {
            type: "string",
            title: "X",
            description: "",
            required: false,
            sensitive: true,
            headerName: "x-flip",
            promptOnPreset: true,
            promptOnInstallation: false,
          },
        },
        presetFieldValues: { [FIELD_KEY]: VALUE },
      });
      let row = await loadRaw(created.id);
      expect(row.presetFieldValues).toEqual({});
      expect(row.presetSecretId).not.toBeNull();

      // Step 2: PUT new userConfig flipping sensitive=false. NO
      // presetFieldValues — schema-only flip.
      const flip = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${created.id}`,
        payload: {
          name,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            [FIELD_KEY]: {
              type: "string",
              title: "X",
              description: "",
              required: false,
              sensitive: false,
              headerName: "x-flip",
              promptOnPreset: true,
              promptOnInstallation: false,
            },
          },
        },
      });
      expect(flip.statusCode).toBe(200);

      // Step 3: value must have migrated bag → jsonb; pointer cleared.
      row = await loadRaw(created.id);
      expect(row.presetFieldValues).toEqual({ [FIELD_KEY]: VALUE });
      expect(row.presetSecretId).toBeNull();
    });

    test("PUT flipping userConfig non-sensitive → sensitive cascades the repartition to CHILD preset rows that already hold a value for the flipped field", async () => {
      const FIELD_KEY = "schema_flip_key";
      const PARENT_NAME = "header-schema-flip-cascade-parent";

      const parent = await createCatalog({
        name: PARENT_NAME,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          [FIELD_KEY]: {
            type: "string",
            title: "X",
            description: "",
            required: false,
            sensitive: false,
            headerName: "x-flip",
            promptOnPreset: true,
            promptOnInstallation: false,
          },
        },
      });

      // Two children with stored values.
      const child1 = await createChild(parent.id, {
        childName: "acme",
        presetFieldValues: { [FIELD_KEY]: "child-acme-val" },
      });
      const child2 = await createChild(parent.id, {
        childName: "globex",
        presetFieldValues: { [FIELD_KEY]: "child-globex-val" },
      });

      // Sanity: both children have the value in plaintext jsonb
      const child1Before = await loadRaw(child1.id);
      const child2Before = await loadRaw(child2.id);
      expect(child1Before.presetFieldValues).toEqual({
        [FIELD_KEY]: "child-acme-val",
      });
      expect(child1Before.presetSecretId).toBeNull();
      expect(child2Before.presetFieldValues).toEqual({
        [FIELD_KEY]: "child-globex-val",
      });
      expect(child2Before.presetSecretId).toBeNull();

      // PUT parent with sensitive=true. No presetFieldValues anywhere.
      const flip = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${parent.id}`,
        payload: {
          name: PARENT_NAME,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            [FIELD_KEY]: {
              type: "string",
              title: "X",
              description: "",
              required: false,
              sensitive: true,
              headerName: "x-flip",
              promptOnPreset: true,
              promptOnInstallation: false,
            },
          },
        },
      });
      expect(flip.statusCode).toBe(200);

      // Both children must have their stored values moved jsonb → bag.
      const child1After = await loadRaw(child1.id);
      expect(child1After.presetFieldValues).toEqual({});
      if (!child1After.presetSecretId) {
        throw new Error("child1 expected presetSecretId after cascade flip");
      }
      const bag1 = await secretManager().getSecret(child1After.presetSecretId);
      expect(bag1?.secret).toEqual({ [FIELD_KEY]: "child-acme-val" });

      const child2After = await loadRaw(child2.id);
      expect(child2After.presetFieldValues).toEqual({});
      if (!child2After.presetSecretId) {
        throw new Error("child2 expected presetSecretId after cascade flip");
      }
      const bag2 = await secretManager().getSecret(child2After.presetSecretId);
      expect(bag2?.secret).toEqual({ [FIELD_KEY]: "child-globex-val" });
    });
  });

  // ===========================================================================
  // Removing / scope-moving a sensitive preset field drops the stored value
  // ===========================================================================
  //
  // The repartition path catches not only `sensitive` flips but also
  // removals and scope changes (preset → installation / static). When a
  // sensitive preset field leaves preset scope, its stored credential
  // must be DROPPED — not migrated into plaintext preset_field_values.
  // The previous repartition wrote the value into the new "nonSecret"
  // bucket because partition only cares about today's secretKeys set; we
  // must filter the effective values to current preset-scoped keys
  // BEFORE feeding them to partition.

  describe("removing / scope-moving a sensitive preset field drops the stored value", () => {
    test("DELETING a sensitive preset field on the parent drops its stored value (does NOT leak it into plaintext jsonb)", async () => {
      const FIELD_KEY = "drop_on_delete_key";
      const name = "header-drop-on-delete";

      const created = await createCatalog({
        name,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          [FIELD_KEY]: {
            type: "string",
            title: "X",
            description: "",
            required: false,
            sensitive: true,
            headerName: "x-drop",
            promptOnPreset: true,
            promptOnInstallation: false,
          },
        },
        presetFieldValues: { [FIELD_KEY]: "credential-value" },
      });
      let row = await loadRaw(created.id);
      expect(row.presetSecretId).not.toBeNull();

      // PUT with empty userConfig — the field is removed entirely.
      const remove = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${created.id}`,
        payload: {
          name,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {},
        },
      });
      expect(remove.statusCode).toBe(200);

      // The credential must NOT have been migrated into plaintext jsonb.
      // The whole field is gone from the schema, so the value belongs
      // nowhere — drop it.
      row = await loadRaw(created.id);
      expect(row.presetFieldValues).toEqual({});
      // And the secret bag pointer should be cleared (the previous fix
      // for the empty-bag case handles this).
      expect(row.presetSecretId).toBeNull();
    });

    test("MOVING a sensitive preset field to installation scope on the parent drops its stored value (does NOT leak it into plaintext jsonb)", async () => {
      const FIELD_KEY = "drop_on_scope_move_key";
      const name = "header-drop-on-scope-move";

      const created = await createCatalog({
        name,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          [FIELD_KEY]: {
            type: "string",
            title: "X",
            description: "",
            required: false,
            sensitive: true,
            headerName: "x-drop",
            promptOnPreset: true,
            promptOnInstallation: false,
          },
        },
        presetFieldValues: { [FIELD_KEY]: "credential-value" },
      });
      let row = await loadRaw(created.id);
      expect(row.presetSecretId).not.toBeNull();

      // PUT moves the field from preset → installation scope.
      // promptOnPreset goes away; promptOnInstallation becomes true. The
      // (still sensitive) field is now per-installation, not per-preset.
      const moveScope = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${created.id}`,
        payload: {
          name,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            [FIELD_KEY]: {
              type: "string",
              title: "X",
              description: "",
              required: false,
              sensitive: true,
              headerName: "x-drop",
              promptOnInstallation: true,
            },
          },
        },
      });
      expect(moveScope.statusCode).toBe(200);

      // The previously-stored credential is no longer applicable (it was
      // the parent-row default-preset value; the field is now per-
      // installation and its value would come from each install's own
      // Secret bag). Drop it — must NOT land in plaintext jsonb.
      row = await loadRaw(created.id);
      expect(row.presetFieldValues).toEqual({});
      expect(row.presetSecretId).toBeNull();
    });

    test("DELETING a sensitive preset field on the parent cascades the drop to CHILD rows (does NOT leak credential into child plaintext jsonb)", async () => {
      const FIELD_KEY = "drop_on_delete_cascade_key";
      const PARENT_NAME = "header-drop-on-delete-cascade-parent";

      const parent = await createCatalog({
        name: PARENT_NAME,
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          [FIELD_KEY]: {
            type: "string",
            title: "X",
            description: "",
            required: false,
            sensitive: true,
            headerName: "x-drop",
            promptOnPreset: true,
            promptOnInstallation: false,
          },
        },
      });
      const child = await createChild(parent.id, {
        childName: "acme",
        presetFieldValues: { [FIELD_KEY]: "child-credential" },
      });
      const childBefore = await loadRaw(child.id);
      expect(childBefore.presetSecretId).not.toBeNull();

      // Remove the field entirely from the parent userConfig.
      const remove = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${parent.id}`,
        payload: {
          name: PARENT_NAME,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {},
        },
      });
      expect(remove.statusCode).toBe(200);

      const childAfter = await loadRaw(child.id);
      expect(childAfter.presetFieldValues).toEqual({});
      expect(childAfter.presetSecretId).toBeNull();
    });
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
