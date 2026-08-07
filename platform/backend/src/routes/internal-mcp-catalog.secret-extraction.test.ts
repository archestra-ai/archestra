import { type Mock, vi } from "vitest";
import { InternalMcpCatalogModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * Registry passwords and enterprise-managed client-secret overrides: the two
 * extraction surfaces that move plaintext out of a jsonb column and into the
 * catalog's secret bag. Env-var extraction lives in the storage-routing and
 * secrets-preservation suites.
 */
describe("Internal MCP Catalog - secret extraction", () => {
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

  test("POST moves an image pull secret password into the bag keyed by server:username", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "regcred-extraction",
          serverType: "local",
          scope: "org",
          localConfig: {
            dockerImage: "registry.example.com/private/mcp:1",
            imagePullSecrets: [
              {
                source: "credentials",
                server: "registry.example.com",
                username: "robot",
                password: "regcred-plaintext",
              },
            ],
          },
        },
      })
    ).json();

    const row = await InternalMcpCatalogModel.findById(created.id, {
      expandSecrets: false,
    });
    expect(JSON.stringify(row?.localConfig)).not.toContain("regcred-plaintext");
    expect(row?.localConfig?.imagePullSecrets?.[0]).toMatchObject({
      source: "credentials",
      server: "registry.example.com",
      username: "robot",
    });

    const bag = await secretManager().getSecret(row?.localConfigSecretId ?? "");
    expect(bag?.secret["__regcred_password:registry.example.com:robot"]).toBe(
      "regcred-plaintext",
    );
  });

  test("PUT omitting an image pull secret password preserves the stored one", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "regcred-preserve",
          serverType: "local",
          scope: "org",
          localConfig: {
            dockerImage: "registry.example.com/private/mcp:1",
            imagePullSecrets: [
              {
                source: "credentials",
                server: "registry.example.com",
                username: "robot",
                password: "regcred-plaintext",
              },
            ],
          },
        },
      })
    ).json();

    // The env var carries a value, so the bag is genuinely rewritten by this
    // PUT. Without it the write is skipped and the old bag survives by
    // accident, which would pass even if preservation were dropped.
    await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${created.id}`,
      payload: {
        localConfig: {
          dockerImage: "registry.example.com/private/mcp:2",
          environment: [
            {
              key: "TOKEN",
              type: "secret",
              value: "token-plaintext",
              promptOnInstallation: false,
            },
          ],
          imagePullSecrets: [
            {
              source: "credentials",
              server: "registry.example.com",
              username: "robot",
            },
          ],
        },
      },
    });

    const row = await InternalMcpCatalogModel.findById(created.id, {
      expandSecrets: false,
    });
    expect(row?.localConfig?.dockerImage).toBe(
      "registry.example.com/private/mcp:2",
    );
    const bag = await secretManager().getSecret(row?.localConfigSecretId ?? "");
    expect(bag?.secret.TOKEN).toBe("token-plaintext");
    expect(bag?.secret["__regcred_password:registry.example.com:robot"]).toBe(
      "regcred-plaintext",
    );
  });

  test("userConfig-only PUT leaves a granted image approval intact", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "approval-preserve",
          serverType: "local",
          scope: "org",
          localConfig: {
            dockerImage: "registry.example.com/private/mcp:1",
            environment: [
              {
                key: "TOKEN",
                type: "secret",
                value: "token-plaintext",
                promptOnInstallation: false,
              },
            ],
          },
        },
      })
    ).json();

    await InternalMcpCatalogModel.approveImage({
      id: created.id,
      reviewedBy: user.id,
    });

    // Touches no localConfig surface, so the image must stay vetted — an edit
    // that merely mentions `localConfig` would re-block installs behind the
    // trusted-image gate.
    const put = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${created.id}`,
      payload: {
        userConfig: {
          some_header: {
            type: "string",
            title: "x-some",
            description: "",
            headerName: "x-some",
            promptOnInstallation: true,
            required: false,
            sensitive: false,
          },
        },
      },
    });
    expect(put.statusCode).toBe(200);

    const row = await InternalMcpCatalogModel.findById(created.id, {
      expandSecrets: false,
    });
    expect(row?.catalogItemApprovalStatus).toBe("approved");
  });

  test("POST moves an enterprise-managed client secret override into the bag", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog",
        payload: {
          name: "enterprise-override-extraction",
          serverType: "remote",
          serverUrl: "https://api.example.com/mcp/",
          scope: "org",
          enterpriseManagedConfig: {
            clientIdOverride: "client-abc",
            clientSecretOverride: "override-plaintext",
          },
        },
      })
    ).json();

    expect(created.clientSecretId).toBeTruthy();

    const row = await InternalMcpCatalogModel.findById(created.id, {
      expandSecrets: false,
    });
    expect(JSON.stringify(row?.enterpriseManagedConfig)).not.toContain(
      "override-plaintext",
    );
    expect(row?.enterpriseManagedConfig?.clientIdOverride).toBe("client-abc");

    const bag = await secretManager().getSecret(row?.clientSecretId ?? "");
    expect(
      bag?.secret[ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY],
    ).toBe("override-plaintext");
  });
});
