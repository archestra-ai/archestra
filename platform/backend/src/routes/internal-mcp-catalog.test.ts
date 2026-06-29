import {
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME,
  TOOL_RUN_TOOL_FULL_NAME,
  TOOL_SEARCH_TOOLS_FULL_NAME,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import { EnvironmentModel, InternalMcpCatalogModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

const mockHasPermission = hasPermission as Mock;

describe("internal MCP catalog routes", () => {
  let app: FastifyInstance;
  let organizationId: string;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    const organization = await makeOrganization();
    organizationId = organization.id;
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send({
          error: { message: error.message, type: error.type },
        });
      }
      const err = error as Error & { statusCode?: number };
      const status = err.statusCode ?? 500;
      return reply.status(status).send({ error: { message: err.message } });
    });
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          user: User;
          organizationId: string;
        }
      ).user = user;
      (
        request as typeof request & {
          user: User;
          organizationId: string;
        }
      ).organizationId = organization.id;
    });
    await app.register(internalMcpCatalogRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("GET /api/internal_mcp_catalog/:id/tools hides implicit Archestra meta tools", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    const agent = await makeAgent();
    await seedAndAssignArchestraTools(agent.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${ARCHESTRA_MCP_CATALOG_ID}/tools`,
    });

    expect(response.statusCode).toBe(200);
    const toolNames = response
      .json()
      .map((tool: { name: string }) => tool.name);
    expect(toolNames).not.toContain(TOOL_QUERY_KNOWLEDGE_SOURCES_FULL_NAME);
    expect(toolNames).not.toContain(TOOL_SEARCH_TOOLS_FULL_NAME);
    expect(toolNames).not.toContain(TOOL_RUN_TOOL_FULL_NAME);
    expect(toolNames).toContain(TOOL_ARTIFACT_WRITE_FULL_NAME);
  });

  test("DELETE /api/internal_mcp_catalog refuses an app-backing catalog (managed via the Apps lifecycle)", async ({
    makeInternalMcpCatalog,
  }) => {
    const appCatalog = await makeInternalMcpCatalog({
      organizationId,
      serverType: "app",
      name: "my-app-backing",
      scope: "personal",
    });

    const byId = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${appCatalog.id}`,
    });
    expect(byId.statusCode).toBe(400);

    const byName = await app.inject({
      method: "DELETE",
      url: "/api/internal_mcp_catalog/by-name/my-app-backing",
    });
    expect(byName.statusCode).toBe(400);

    // The catalog still exists — neither delete path removed it.
    expect(
      await InternalMcpCatalogModel.findById(appCatalog.id),
    ).not.toBeNull();
  });

  test("DELETE /api/internal_mcp_catalog/by-name/:name is scoped to the active organization", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      name: "other-org-catalog",
      organizationId: otherOrganization.id,
      scope: "org",
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/internal_mcp_catalog/by-name/other-org-catalog",
    });

    expect(response.statusCode).toBe(404);
    await expect(
      InternalMcpCatalogModel.findById(catalog.id),
    ).resolves.not.toBeNull();

    await makeInternalMcpCatalog({
      name: "active-org-catalog",
      organizationId,
      scope: "org",
    });

    const activeOrgResponse = await app.inject({
      method: "DELETE",
      url: "/api/internal_mcp_catalog/by-name/active-org-catalog",
    });

    expect(activeOrgResponse.statusCode).toBe(200);
  });

  test("POST /api/internal_mcp_catalog rejects a clonedFrom in another organization", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    const foreignSource = await makeInternalMcpCatalog({
      name: "foreign-clone-source",
      organizationId: otherOrganization.id,
      scope: "org",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "clone-of-foreign",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        clonedFrom: foreignSource.id,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("POST /api/internal_mcp_catalog accepts a clonedFrom in the active organization", async ({
    makeInternalMcpCatalog,
  }) => {
    const source = await makeInternalMcpCatalog({
      name: "same-org-clone-source",
      organizationId,
      scope: "org",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "clone-of-same-org",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        clonedFrom: source.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().clonedFrom).toBe(source.id);
  });

  describe("network egress policy enforcement (remote servers)", () => {
    async function makeRestrictedEnv(allowedDomains: string[]) {
      return EnvironmentModel.create({
        organizationId,
        name: `restricted-${crypto.randomUUID().slice(0, 8)}`,
        networkPolicy: {
          egressMode: "restricted",
          domainPreset: "none",
          allowedDomains,
          allowedCidrs: [],
        },
      });
    }

    test("POST blocks a remote server whose URL host is not allowed by its environment", async () => {
      const env = await makeRestrictedEnv(["allowed.example.com"]);

      const response = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "blocked-remote",
          serverType: "remote",
          serverUrl: "https://evil.example.com/mcp",
          environmentId: env.id,
          scope: "org",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("not permitted");
    });

    test("POST allows a remote server whose URL host is in the environment allowlist", async () => {
      const env = await makeRestrictedEnv(["allowed.example.com"]);

      const response = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "allowed-remote",
          serverType: "remote",
          serverUrl: "https://allowed.example.com/mcp",
          environmentId: env.id,
          scope: "org",
        },
      });

      expect(response.statusCode).toBe(200);
    });

    test("POST does not apply the egress policy to self-hosted servers", async () => {
      const env = await makeRestrictedEnv(["allowed.example.com"]);

      const response = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "self-hosted-in-restricted-env",
          serverType: "local",
          environmentId: env.id,
          scope: "org",
          localConfig: { command: "node", arguments: ["server.js"] },
        },
      });

      expect(response.statusCode).toBe(200);
    });

    test("POST allows a remote server with no environment (built-in default)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "no-env-remote",
          serverType: "remote",
          serverUrl: "https://anything.example.com/mcp",
          scope: "org",
        },
      });

      expect(response.statusCode).toBe(200);
    });

    test("PUT grandfathers an existing remote server when an unrelated field changes", async ({
      makeInternalMcpCatalog,
    }) => {
      const env = await makeRestrictedEnv(["allowed.example.com"]);
      // Seeded via the model, bypassing route validation — simulates a server
      // that predates the policy (or the feature).
      const item = await makeInternalMcpCatalog({
        organizationId,
        environmentId: env.id,
        serverType: "remote",
        serverUrl: "https://legacy.example.com/mcp",
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${item.id}`,
        payload: { description: "updated description" },
      });

      expect(response.statusCode).toBe(200);
    });

    test("PUT re-validates the URL against the policy when the URL changes", async ({
      makeInternalMcpCatalog,
    }) => {
      const env = await makeRestrictedEnv(["allowed.example.com"]);
      const item = await makeInternalMcpCatalog({
        organizationId,
        environmentId: env.id,
        serverType: "remote",
        serverUrl: "https://allowed.example.com/mcp",
      });

      const blocked = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${item.id}`,
        payload: { serverUrl: "https://other.example.com/mcp" },
      });
      expect(blocked.statusCode).toBe(400);

      const allowed = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${item.id}`,
        payload: { serverUrl: "https://allowed.example.com/v2/mcp" },
      });
      expect(allowed.statusCode).toBe(200);
    });

    test("PUT re-validates the URL when moving the server into a stricter environment", async ({
      makeInternalMcpCatalog,
    }) => {
      // No environment initially → built-in default allows everything.
      const item = await makeInternalMcpCatalog({
        organizationId,
        serverType: "remote",
        serverUrl: "https://legacy.example.com/mcp",
      });
      const env = await makeRestrictedEnv(["allowed.example.com"]);

      const response = await app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${item.id}`,
        payload: { environmentId: env.id },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  test("POST clone carries over the source's local-config secret as an independent copy", async () => {
    const source = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "clone-secret-src-local",
          serverType: "local",
          scope: "org",
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            environment: [
              {
                key: "QA_SECRET",
                type: "secret",
                value: "src-secret-value",
                promptOnInstallation: false,
              },
            ],
          },
        },
      })
    ).json();
    expect(source.localConfigSecretId).toBeTruthy();

    // The clone form is seeded from the list endpoint, which does not expand
    // secrets, so the clone payload carries the env var key but no value.
    const clone = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "clone-secret-src-local-copy",
          serverType: "local",
          clonedFrom: source.id,
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            environment: [
              { key: "QA_SECRET", type: "secret", promptOnInstallation: false },
            ],
          },
        },
      })
    ).json();
    expect(clone.localConfigSecretId).toBeTruthy();
    expect(clone.localConfigSecretId).not.toBe(source.localConfigSecretId);

    // GET expands secrets: the cloned value resolves to the source's.
    const full = (
      await app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${clone.id}`,
      })
    ).json();
    const envVar = full.localConfig.environment.find(
      (e: { key: string }) => e.key === "QA_SECRET",
    );
    expect(envVar.value).toBe("src-secret-value");
  });

  test("POST clone keeps a secret value supplied in the clone payload over the source's", async () => {
    const source = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "clone-secret-src-override",
          serverType: "local",
          scope: "org",
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            environment: [
              {
                key: "QA_SECRET",
                type: "secret",
                value: "src-secret-value",
                promptOnInstallation: false,
              },
            ],
          },
        },
      })
    ).json();

    const clone = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "clone-secret-src-override-copy",
          serverType: "local",
          clonedFrom: source.id,
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            environment: [
              {
                key: "QA_SECRET",
                type: "secret",
                value: "override-value",
                promptOnInstallation: false,
              },
            ],
          },
        },
      })
    ).json();
    expect(clone.localConfigSecretId).toBeTruthy();
    expect(clone.localConfigSecretId).not.toBe(source.localConfigSecretId);

    const full = (
      await app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${clone.id}`,
      })
    ).json();
    const envVar = full.localConfig.environment.find(
      (e: { key: string }) => e.key === "QA_SECRET",
    );
    expect(envVar.value).toBe("override-value");
  });

  test("POST clone carries over the source's OAuth client secret as an independent copy", async () => {
    const oauthConfig = {
      name: "oauth",
      server_url: "https://example.com",
      client_id: "cid",
      redirect_uris: [],
      scopes: [],
      default_scopes: [],
      supports_resource_metadata: false,
    };

    const source = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "clone-secret-src-oauth",
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          scope: "org",
          oauthConfig: { ...oauthConfig, client_secret: "oauth-secret-value" },
        },
      })
    ).json();
    expect(source.clientSecretId).toBeTruthy();

    // Clone payload omits client_secret (the list endpoint never exposed it).
    const clone = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "clone-secret-src-oauth-copy",
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          clonedFrom: source.id,
          oauthConfig,
        },
      })
    ).json();
    expect(clone.clientSecretId).toBeTruthy();
    expect(clone.clientSecretId).not.toBe(source.clientSecretId);

    const full = (
      await app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${clone.id}`,
      })
    ).json();
    expect(full.oauthConfig.client_secret).toBe("oauth-secret-value");
  });

  test("POST clone merges per key: overriding one secret keeps the inherited siblings", async () => {
    const source = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "clone-secret-src-multikey",
          serverType: "local",
          scope: "org",
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            environment: [
              {
                key: "KEY_A",
                type: "secret",
                value: "src-a",
                promptOnInstallation: false,
              },
              {
                key: "KEY_B",
                type: "secret",
                value: "src-b",
                promptOnInstallation: false,
              },
            ],
          },
        },
      })
    ).json();

    // Clone overrides only KEY_A; KEY_B is left blank and must still inherit.
    const clone = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "clone-secret-src-multikey-copy",
          serverType: "local",
          clonedFrom: source.id,
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            environment: [
              {
                key: "KEY_A",
                type: "secret",
                value: "override-a",
                promptOnInstallation: false,
              },
              { key: "KEY_B", type: "secret", promptOnInstallation: false },
            ],
          },
        },
      })
    ).json();

    const env = (
      await app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${clone.id}`,
      })
    ).json().localConfig.environment;
    expect(env.find((e: { key: string }) => e.key === "KEY_A").value).toBe(
      "override-a",
    );
    expect(env.find((e: { key: string }) => e.key === "KEY_B").value).toBe(
      "src-b",
    );
  });

  test("POST ignores a client-supplied secret FK in the body", async ({
    makeSecret,
  }) => {
    // A secret the caller does not legitimately own via this request.
    const foreignSecret = await makeSecret({
      name: "foreign-secret",
      secret: { API_KEY: "do-not-touch" },
    });

    const created = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "ignore-inbound-fk",
          serverType: "local",
          scope: "org",
          localConfigSecretId: foreignSecret.id,
          localConfig: {
            command: "node",
            arguments: ["server.js"],
            environment: [
              { key: "API_KEY", type: "secret", promptOnInstallation: false },
            ],
          },
        },
      })
    ).json();

    // The inbound FK is dropped: no value was supplied, so no secret is linked.
    expect(created.localConfigSecretId).toBeNull();
  });
});
