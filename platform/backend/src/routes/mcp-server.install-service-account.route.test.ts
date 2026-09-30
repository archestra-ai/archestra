import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import runtime from "@/k8s/mcp-server-runtime/manager";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import OrganizationModel from "@/models/organization";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { InternalMcpCatalog, User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import routes from "./mcp-server";

const ordinaryConfig = { command: "node", arguments: ["server.js"] };

describe("install account overrides use catalog administration permissions", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let admin: User;
  let organizationId: string;
  let catalog: InternalMcpCatalog;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      organizationId = (await makeOrganization()).id;
      user = await makeUser();
      admin = await makeUser();
      await makeMember(user.id, organizationId, { role: "member" });
      await makeMember(admin.id, organizationId, { role: "admin" });
      catalog = await makeInternalMcpCatalog({
        organizationId,
        authorId: admin.id,
        access: "org",
        serverType: "local",
        localConfig: ordinaryConfig,
      });
      vi.spyOn(runtime, "startServer").mockResolvedValue(undefined);
      vi.spyOn(runtime, "restartServer").mockResolvedValue(undefined);
      vi.spyOn(runtime, "getOrLoadDeployment").mockResolvedValue(undefined);
      vi.spyOn(mcpClient, "connectAndGetTools").mockResolvedValue([]);
      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        request.user = user;
        request.organizationId = organizationId;
      });
      await app.register(routes);
    },
  );

  afterEach(async () => {
    await drainBackgroundWork();
    await app.close();
    vi.restoreAllMocks();
  });

  function install(extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/mcp_server",
      payload: {
        name: "installation",
        catalogId: catalog.id,
        scope: "personal",
        ...extra,
      },
    });
  }

  test("member cannot change a shared account through install, before side effects", async () => {
    const response = await install({
      serviceAccount: "approved-runtime",
      accessToken: "unused-value",
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig,
    ).toEqual(ordinaryConfig);
    expect(await McpServerModel.findByCatalogId(catalog.id)).toEqual([]);
    expect(await SecretModel.count()).toBe(0);
    expect(runtime.startServer).not.toHaveBeenCalled();
  });

  test.each([
    undefined,
    "",
    "default",
  ])("member install preserves omitted/empty/default account %j", async (serviceAccount) => {
    const response = await install({ serviceAccount });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig,
    ).toEqual(ordinaryConfig);
    expect(runtime.startServer).toHaveBeenCalledOnce();
  });

  test("member can echo an existing approved account without acquiring catalog edit permission", async () => {
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: { ...ordinaryConfig, serviceAccount: "approved-runtime" },
    });
    const response = await install({ serviceAccount: "approved-runtime" });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
        ?.serviceAccount,
    ).toBe("approved-runtime");
  });

  test("an existing personal install still checks account permissions", async ({
    makeMcpServer,
  }) => {
    const server = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
      serverType: "local",
      localInstallationStatus: "success",
    });
    const response = await install({ serviceAccount: "approved-runtime" });
    expect(response.statusCode, response.body).toBe(403);
    expect(
      (await McpServerModel.findById(server.id))?.localInstallationStatus,
    ).toBe("success");
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig,
    ).toEqual(ordinaryConfig);
    expect(runtime.startServer).not.toHaveBeenCalled();
  });

  test("registry administrator retains install-time account selection", async () => {
    user = admin;
    const response = await install({ serviceAccount: "approved-runtime" });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
        ?.serviceAccount,
    ).toBe("approved-runtime");
  });

  test("administrator duplicate install returns the existing installation without publishing an account", async ({
    makeMcpServer,
  }) => {
    user = admin;
    const localConfig: NonNullable<InternalMcpCatalog["localConfig"]> = {
      ...ordinaryConfig,
      environment: [
        {
          key: "REQUIRED",
          type: "plain_text",
          promptOnInstallation: true,
          required: true,
        },
      ],
    };
    await InternalMcpCatalogModel.update(catalog.id, { localConfig });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
      serverType: "local",
      localInstallationStatus: "success",
    });
    const response = await install({ serviceAccount: "replacement-runtime" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().id).toBe(server.id);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig,
    ).toEqual(localConfig);
    expect(await McpServerModel.findById(server.id)).toMatchObject(server);
    expect(runtime.startServer).not.toHaveBeenCalled();
  });

  test.for([
    undefined,
    "approved-runtime",
  ])("member reinstall preserves omitted or equal account %j", async (serviceAccount, {
    makeMcpServer,
  }) => {
    const localConfig = {
      ...ordinaryConfig,
      serviceAccount: "approved-runtime",
    };
    await InternalMcpCatalogModel.update(catalog.id, { localConfig });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
      serverType: "local",
      localInstallationStatus: "success",
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${server.id}/reinstall`,
      payload: { serviceAccount },
    });
    expect(response.statusCode, response.body).toBe(200);
    await drainBackgroundWork();
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig,
    ).toEqual(localConfig);
    expect(runtime.restartServer).toHaveBeenCalledOnce();
  });

  test("member reinstall cannot change or clear an account or mutate install state", async ({
    makeMcpServer,
  }) => {
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: { ...ordinaryConfig, serviceAccount: "approved-runtime" },
    });
    const bag = await secretManager().createSecret(
      { TOKEN: "original-value" },
      "install-values",
    );
    const server = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
      serverType: "local",
      secretId: bag.id,
      localInstallationStatus: "success",
    });
    for (const serviceAccount of ["different-runtime", ""]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/mcp_server/${server.id}/reinstall`,
        payload: {
          serviceAccount,
          environmentValues: { TOKEN: "replacement-value" },
        },
      });
      expect(response.statusCode, response.body).toBe(403);
    }
    expect(
      (await McpServerModel.findById(server.id))?.localInstallationStatus,
    ).toBe("success");
    expect((await SecretModel.findById(bag.id))?.secret).toEqual({
      TOKEN: "original-value",
    });
    expect(runtime.restartServer).not.toHaveBeenCalled();
  });

  test("administrator reinstall can explicitly clear a configured account", async ({
    makeMcpServer,
  }) => {
    user = admin;
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: { ...ordinaryConfig, serviceAccount: "approved-runtime" },
    });
    const server = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
      serverType: "local",
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${server.id}/reinstall`,
      payload: { serviceAccount: "" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
        ?.serviceAccount,
    ).toBe("");
  });

  test("catalog secret bags cannot be aliased into an install and overwritten", async () => {
    const bag = await secretManager().createSecret(
      { TOKEN: "catalog-value" },
      "catalog-values",
    );
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfigSecretId: bag.id,
    });
    const response = await install({
      secretId: bag.id,
      accessToken: "replacement-value",
    });
    expect(response.statusCode, response.body).toBe(403);
    expect((await SecretModel.findById(bag.id))?.secret).toEqual({
      TOKEN: "catalog-value",
    });
    expect(await McpServerModel.findByCatalogId(catalog.id)).toEqual([]);
  });

  for (const operation of ["install", "reinstall"]) {
    test.for([
      "required environment",
      "required connection setting",
      "environment regex",
      "image policy",
      "unavailable vault",
    ] as const)(`administrator ${operation} preserves the shared account after %s refusal`, async (reason, {
      makeMcpServer,
    }) => {
      const memberId = user.id;
      user = admin;
      const localConfig: NonNullable<InternalMcpCatalog["localConfig"]> = {
        ...ordinaryConfig,
        serviceAccount: "original-runtime",
        environment: [
          {
            key: "INPUT",
            type: "plain_text",
            promptOnInstallation: true,
            required: reason === "required environment",
          },
        ],
        ...(reason === "image policy"
          ? { dockerImage: "registry.example.com/pending/server:1" }
          : {}),
      };
      await InternalMcpCatalogModel.update(catalog.id, {
        localConfig,
        ...(reason === "image policy" ? { authorId: memberId } : {}),
        ...(reason === "required connection setting"
          ? {
              userConfig: {
                requiredSetting: {
                  type: "string",
                  title: "Required setting",
                  description: "Connection setting",
                  required: true,
                  promptOnInstallation: true,
                },
              },
            }
          : {}),
      });
      if (reason === "environment regex") {
        await OrganizationModel.patch(organizationId, {
          defaultEnvironmentValidationRegex: "^allowed$",
        });
      }
      if (reason === "image policy") {
        await OrganizationModel.patch(organizationId, {
          defaultEnvironmentTrustedImageRegistries: [
            "registry.example.com/approved",
          ],
        });
      }
      const bag =
        operation === "reinstall"
          ? await secretManager().createSecret(
              { TOKEN: "original-value" },
              "existing-install-values",
            )
          : null;
      const server =
        operation === "reinstall"
          ? await makeMcpServer({
              catalogId: catalog.id,
              ownerId: user.id,
              scope: "personal",
              serverType: "local",
              secretId: bag?.id,
              localInstallationStatus: "success",
            })
          : null;
      const payload = {
        serviceAccount: "replacement-runtime",
        ...(reason === "environment regex"
          ? { environmentValues: { INPUT: "other" } }
          : {}),
        ...(reason === "unavailable vault"
          ? { isByosVault: true, environmentValues: { INPUT: "allowed" } }
          : {}),
      };
      const response = server
        ? await app.inject({
            method: "POST",
            url: `/api/mcp_server/${server.id}/reinstall`,
            payload,
          })
        : await install({ ...payload, accessToken: "unused-value" });
      expect(response.statusCode, response.body).toBe(
        reason === "image policy" ? 403 : 400,
      );
      expect(
        (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig,
      ).toEqual(localConfig);
      if (reason === "image policy") {
        expect(
          (await InternalMcpCatalogModel.findById(catalog.id))
            ?.catalogItemApprovalStatus,
        ).toBe("pending");
      }
      if (server && bag) {
        expect(await McpServerModel.findById(server.id)).toMatchObject(server);
        expect((await SecretModel.findById(bag.id))?.secret).toEqual({
          TOKEN: "original-value",
        });
      } else {
        expect(await McpServerModel.findByCatalogId(catalog.id)).toEqual([]);
      }
      expect(await SecretModel.count()).toBe(bag ? 1 : 0);
      expect(runtime.startServer).not.toHaveBeenCalled();
      expect(runtime.restartServer).not.toHaveBeenCalled();
    });

    test(`administrator ${operation} reports a concurrent catalog edit before publishing an account`, async ({
      makeMcpServer,
    }) => {
      user = admin;
      const server =
        operation === "reinstall"
          ? await makeMcpServer({
              catalogId: catalog.id,
              ownerId: user.id,
              scope: "personal",
              serverType: "local",
              localInstallationStatus: "success",
            })
          : null;
      const reviewed = await InternalMcpCatalogModel.findById(catalog.id, {
        expandSecrets: false,
      });
      if (!reviewed) throw new Error("Missing catalog");
      const findById = InternalMcpCatalogModel.findById.bind(
        InternalMcpCatalogModel,
      );
      let interleaved = false;
      vi.spyOn(InternalMcpCatalogModel, "findById").mockImplementation(
        async (...args) => {
          const snapshot = await findById(...args);
          if (args[0] === catalog.id && !interleaved) {
            interleaved = true;
            await InternalMcpCatalogModel.publishReviewed({
              original: reviewed,
              updates: {
                localConfig: {
                  command: "python",
                  arguments: ["concurrent-editor.py"],
                },
              },
            });
          }
          return snapshot;
        },
      );
      const response = server
        ? await app.inject({
            method: "POST",
            url: `/api/mcp_server/${server.id}/reinstall`,
            payload: { serviceAccount: "approved-runtime" },
          })
        : await install({ serviceAccount: "approved-runtime" });
      expect(interleaved).toBe(true);
      expect(response.statusCode, response.body).toBe(409);
      expect(
        (await findById(catalog.id, { expandSecrets: false }))?.localConfig,
      ).toEqual({ command: "python", arguments: ["concurrent-editor.py"] });
      expect(runtime.startServer).not.toHaveBeenCalled();
      expect(runtime.restartServer).not.toHaveBeenCalled();
      if (server)
        expect(
          (await McpServerModel.findById(server.id))?.localInstallationStatus,
        ).toBe("success");
      else expect(await McpServerModel.findByCatalogId(catalog.id)).toEqual([]);
    });
  }

  test("only declared installer inputs reach local process setup", async () => {
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: {
        ...ordinaryConfig,
        environment: [
          { key: "PROMPTED", type: "plain_text", promptOnInstallation: true },
          {
            key: "STATIC",
            type: "plain_text",
            promptOnInstallation: false,
            value: "catalog-value",
          },
        ],
      },
      userConfig: {
        prompted: {
          type: "string",
          title: "Input",
          description: "Input",
          promptOnInstallation: true,
        },
        fixed: {
          type: "string",
          title: "Fixed",
          description: "Fixed",
          promptOnInstallation: false,
          default: "catalog-value",
        },
      },
    });
    const response = await install({
      environmentValues: {
        PROMPTED: "provided",
        STATIC: "ignored",
        UNDECLARED: "ignored",
      },
      userConfigValues: {
        prompted: "provided",
        fixed: "ignored",
        unknown: "ignored",
        constructor: "ignored",
        toString: "ignored",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(runtime.startServer).toHaveBeenCalledWith(
      expect.anything(),
      { prompted: "provided" },
      { PROMPTED: "provided" },
    );
    const server = await McpServerModel.findById(response.json().id);
    expect(server?.environmentValues).toEqual({ PROMPTED: "provided" });
    const bag = server?.secretId
      ? await SecretModel.findById(server.secretId)
      : null;
    expect(bag?.secret).toEqual({ prompted: "provided" });
  });
});
