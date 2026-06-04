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

describe("Internal MCP Catalog - Header User Config Routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id, { role: "admin" });

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
  // Validator matrix: header-mapped userConfig + `sensitive` flag
  // ===========================================================================
  //
  // Server-side contract (validateHeaderMappedUserConfig in types/mcp-catalog.ts):
  //   `sensitive: true` is only legal for install-prompted fields. Static
  //   fields (`promptOnInstallation === false`) must not be sensitive — their
  //   value lives in `userConfig.default` plaintext on the catalog row.

  describe("header sensitive-flag validator", () => {
    type Row = {
      caseId: string;
      promptOnInstallation: boolean | undefined;
      sensitive: boolean;
      expectedStatus: 200 | 400;
      description: string;
    };

    const rows = [
      {
        caseId: "static-explicit",
        promptOnInstallation: false,
        sensitive: true,
        expectedStatus: 400,
        description: "static + sensitive → rejected",
      },
      {
        caseId: "install-sensitive",
        promptOnInstallation: true,
        sensitive: true,
        expectedStatus: 200,
        description: "install + sensitive → accepted",
      },
      {
        caseId: "static-nonsensitive",
        promptOnInstallation: false,
        sensitive: false,
        expectedStatus: 200,
        description: "static + non-sensitive → accepted (baseline)",
      },
    ] satisfies Row[];

    function buildUserConfigField(row: Row): Record<string, unknown> {
      // Conditionally include the prompt flags so "omitted" really means
      // omitted on the wire (not "explicitly undefined", which JSON drops
      // anyway but is semantically distinct from "explicitly false" in the
      // raw form-data world).
      const field: Record<string, unknown> = {
        type: "string",
        title: "Test Header",
        description: "Matrix-test header",
        required: false,
        sensitive: row.sensitive,
        headerName: "x-test-header",
      };
      if (row.promptOnInstallation !== undefined) {
        field.promptOnInstallation = row.promptOnInstallation;
      }
      return field;
    }

    function expectValidatorOutcome(
      response: { statusCode: number; json: () => unknown },
      row: Row,
    ): void {
      expect(response.statusCode).toBe(row.expectedStatus);
      const body = response.json() as Record<string, unknown>;
      if (row.expectedStatus === 400) {
        expect(body).toMatchObject({
          error: {
            message: expect.stringContaining(
              "Static header-mapped userConfig fields cannot be marked sensitive",
            ),
          },
        });
      } else {
        // Accepted rows must persist all three flags exactly as sent so the
        // round-trip back to the frontend matches the wire shape it sent.
        const persisted = (
          body.userConfig as Record<string, Record<string, unknown>>
        ).test_field;
        expect(persisted.sensitive).toBe(row.sensitive);
        if (row.promptOnInstallation !== undefined) {
          expect(persisted.promptOnInstallation).toBe(row.promptOnInstallation);
        }
      }
    }

    describe("via POST /api/internal_mcp_catalog", () => {
      test.each(rows)("$description", async (row) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/internal_mcp_catalog",
          payload: {
            name: `header-validator-post-${row.caseId}`,
            serverType: "remote",
            serverUrl: "https://example.com/mcp",
            userConfig: { test_field: buildUserConfigField(row) },
          },
        });
        expectValidatorOutcome(response, row);
      });
    });

    describe("via PUT /api/internal_mcp_catalog/:id", () => {
      test.each(rows)("$description", async (row) => {
        // Seed a minimal baseline catalog the PUT can target. We can't
        // re-use the matrix row for the baseline because the baseline must
        // always succeed (we need an :id to PUT against), so it carries a
        // known-good shape: empty userConfig.
        const baselineName = `header-validator-put-baseline-${row.caseId}`;
        const baseline = await app.inject({
          method: "POST",
          url: "/api/internal_mcp_catalog",
          payload: {
            name: baselineName,
            serverType: "remote",
            serverUrl: "https://example.com/mcp",
          },
        });
        expect(baseline.statusCode).toBe(200);
        const baselineId = (baseline.json() as { id: string }).id;

        const response = await app.inject({
          method: "PUT",
          url: `/api/internal_mcp_catalog/${baselineId}`,
          payload: {
            name: baselineName,
            serverType: "remote",
            serverUrl: "https://example.com/mcp",
            userConfig: { test_field: buildUserConfigField(row) },
          },
        });
        expectValidatorOutcome(response, row);
      });
    });
  });

  // ===========================================================================
  // Sensitive headers must not carry a plaintext `default`
  // ===========================================================================
  //
  // A sensitive install-prompted header with a `default` would send that
  // default in plaintext for any caller without an overlay — defeating the
  // point of marking the field sensitive. The validator must reject the
  // combination at the door.

  describe("sensitive header-mapped fields cannot carry a plaintext default", () => {
    type Row = {
      caseId: string;
      promptOnInstallation: boolean | undefined;
      description: string;
    };

    const rows: Row[] = [
      {
        caseId: "install",
        promptOnInstallation: true,
        description:
          "install + sensitive + default → rejected (default would be sent in plaintext for any caller without an overlay)",
      },
    ];

    function buildField(row: Row): Record<string, unknown> {
      const f: Record<string, unknown> = {
        type: "string",
        title: "Sensitive w/ default",
        description: "",
        required: false,
        sensitive: true,
        headerName: "x-sens-default",
        default: "plaintext-leak",
      };
      if (row.promptOnInstallation !== undefined) {
        f.promptOnInstallation = row.promptOnInstallation;
      }
      return f;
    }

    describe.each(["POST", "PUT"] as const)("via %s", (method) => {
      test.each(rows)("$description", async (row) => {
        const name = `header-sens-default-${method.toLowerCase()}-${row.caseId}`;
        const sendOffendingPayload = async (
          url: string,
          httpMethod: "POST" | "PUT",
        ) =>
          app.inject({
            method: httpMethod,
            url,
            payload: {
              name,
              serverType: "remote",
              serverUrl: "https://example.com/mcp",
              userConfig: { test_field: buildField(row) },
            },
          });

        let response: Awaited<ReturnType<typeof app.inject>>;
        if (method === "POST") {
          response = await sendOffendingPayload(
            "/api/internal_mcp_catalog",
            "POST",
          );
        } else {
          // Seed a minimal catalog, then PUT the offending payload.
          const baseline = await app.inject({
            method: "POST",
            url: "/api/internal_mcp_catalog",
            payload: {
              name,
              serverType: "remote",
              serverUrl: "https://example.com/mcp",
            },
          });
          expect(baseline.statusCode).toBe(200);
          response = await sendOffendingPayload(
            `/api/internal_mcp_catalog/${baseline.json().id}`,
            "PUT",
          );
        }
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: {
            message: expect.stringContaining(
              "Sensitive header-mapped userConfig fields cannot carry a plaintext default",
            ),
          },
        });
      });
    });

    test("the same field WITHOUT `default` is still accepted (control)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "header-sens-no-default-control",
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          userConfig: {
            test_field: {
              type: "string",
              title: "Sensitive w/o default",
              description: "",
              required: false,
              sensitive: true,
              headerName: "x-sens-clean",
              promptOnInstallation: true,
            },
          },
        },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  test("creates a catalog item with static non-sensitive headers inline without creating a backing secret", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "header-inline-route",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Static non-sensitive auth token",
            required: true,
            sensitive: false,
            headerName: "x-api-key",
            promptOnInstallation: false,
            default: "header-inline-789",
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.localConfigSecretId).toBeNull();
    expect(body.userConfig.access_token.default).toBe("header-inline-789");
  });

  test("updates a static non-sensitive header while preserving existing secret-backed env values and inline non-sensitive headers", async ({
    makeSecret,
  }) => {
    const existingSecret = await makeSecret({
      name: "existing-header-secret",
      secret: {
        access_token: "persisted-secret-token",
      },
    });

    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "header-update-route",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        localConfigSecretId: existingSecret.id,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "API_SECRET",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Static non-sensitive auth token",
            required: true,
            sensitive: false,
            headerName: "x-api-key",
            promptOnInstallation: false,
            default: "persisted-inline-token",
          },
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        userConfig: {
          access_token: {
            type: "string",
            title: "Access Token",
            description: "Static non-sensitive auth token",
            required: true,
            sensitive: false,
            headerName: "x-api-key",
            promptOnInstallation: false,
            default: "updated-inline-token",
          },
          tenant_id: {
            type: "string",
            title: "Tenant ID",
            description: "Static non-sensitive tenant header",
            required: false,
            sensitive: false,
            headerName: "x-tenant-id",
            promptOnInstallation: false,
            default: "tenant-42",
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.userConfig.access_token.default).toBe("updated-inline-token");
    expect(body.userConfig.tenant_id.default).toBe("tenant-42");

    const storedSecret = await secretManager().getSecret(existingSecret.id);
    expect(storedSecret?.secret).toMatchObject({
      access_token: "persisted-secret-token",
    });
    expect(storedSecret?.secret).not.toHaveProperty("tenant_id");
  });

  test("rejects case-insensitive duplicate header names", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "duplicate-headers-route",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        userConfig: {
          first_header: {
            type: "string",
            title: "First Header",
            description: "First",
            required: false,
            sensitive: false,
            headerName: "X-Api-Key",
            promptOnInstallation: true,
          },
          second_header: {
            type: "string",
            title: "Second Header",
            description: "Second",
            required: false,
            sensitive: false,
            headerName: "x-api-key",
            promptOnInstallation: true,
          },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: expect.stringContaining("Header name duplicates field"),
      },
    });
  });

  test("deletes the backing secret when deleting a catalog item with secret-backed local config", async ({
    makeSecret,
  }) => {
    const existingSecret = await makeSecret({
      name: "delete-header-secret",
      secret: {
        API_SECRET: "delete-me",
      },
    });

    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "header-delete-route",
        serverType: "local",
        localConfigSecretId: existingSecret.id,
        localConfig: {
          command: "node",
          arguments: ["server.js"],
          environment: [
            {
              key: "API_SECRET",
              type: "secret",
              promptOnInstallation: false,
            },
          ],
        },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    const deletedSecret = await secretManager().getSecret(existingSecret.id);
    expect(deletedSecret).toBeNull();

    const deletedCatalog = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(deletedCatalog).toBeNull();
  });
});
