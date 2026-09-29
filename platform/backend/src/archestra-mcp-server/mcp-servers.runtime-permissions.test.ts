import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import { beforeEach, describe, expect, test } from "@/test";
import type { InternalMcpCatalog } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const prefix = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}`;
const ordinaryConfig = { command: "node", arguments: ["server.js"] };

function text(result: Awaited<ReturnType<typeof executeArchestraTool>>) {
  return result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}

describe("MCP tools enforce runtime authoring permissions", () => {
  let context: ArchestraContext;
  let adminId: string;
  let catalog: InternalMcpCatalog;

  beforeEach(
    async ({
      makeOrganization,
      makeAgent,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      const organization = await makeOrganization();
      const editor = await makeUser();
      const admin = await makeUser();
      adminId = admin.id;
      await makeMember(editor.id, organization.id, { role: "editor" });
      await makeMember(admin.id, organization.id, { role: "admin" });
      const agent = await makeAgent({ organizationId: organization.id });
      context = {
        agent: { id: agent.id, name: agent.name },
        userId: editor.id,
        organizationId: organization.id,
      };
      catalog = await makeInternalMcpCatalog({
        organizationId: organization.id,
        authorId: editor.id,
        serverType: "local",
        access: "personal",
        localConfig: ordinaryConfig,
      });
    },
  );

  test("scoped editor keeps ordinary local creation and editing", async () => {
    const created = await executeArchestraTool(
      `${prefix}create_mcp_server`,
      { name: "ordinary-runtime", serverType: "local", ...ordinaryConfig },
      context,
    );
    expect(created.isError, text(created)).toBe(false);
    const edited = await executeArchestraTool(
      `${prefix}edit_mcp_config`,
      { id: catalog.id, arguments: ["updated.js"] },
      context,
    );
    expect(edited.isError, text(edited)).toBe(false);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
        ?.arguments,
    ).toEqual(["updated.js"]);
  });

  test.each([
    { serviceAccount: "approved-runtime" },
    { envFrom: [{ type: "secret", name: "runtime-values" }] },
    {
      deploymentSpecYaml:
        "apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      serviceAccount: approved-runtime\n",
    },
  ])("scoped editor cannot create or add privileged config %j", async (privilege) => {
    const edited = await executeArchestraTool(
      `${prefix}edit_mcp_config`,
      { id: catalog.id, ...privilege },
      context,
    );
    expect(edited.isError, text(edited)).toBe(true);
    expect(text(edited)).toContain("administrator access");
    const created = await executeArchestraTool(
      `${prefix}create_mcp_server`,
      {
        name: "privileged-runtime",
        serverType: "local",
        ...ordinaryConfig,
        ...privilege,
      },
      context,
    );
    expect(created.isError, text(created)).toBe(true);
    expect(text(created)).toContain("administrator access");
    expect(
      await InternalMcpCatalogModel.findByName("privileged-runtime"),
    ).toBeNull();
  });

  test("unchanged identity cannot authorize executable or secret changes", async () => {
    const bag = await secretManager().createSecret(
      { TOKEN: "original-value" },
      "catalog-values",
    );
    const config = {
      ...ordinaryConfig,
      serviceAccount: "approved-runtime",
      environment: [
        { key: "TOKEN", type: "secret" as const, promptOnInstallation: false },
      ],
    };
    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: config,
      localConfigSecretId: bag.id,
    });
    const edited = await executeArchestraTool(
      `${prefix}edit_mcp_config`,
      {
        id: catalog.id,
        serviceAccount: "approved-runtime",
        arguments: ["different.js"],
        environment: [{ ...config.environment[0], value: "replacement-value" }],
      },
      context,
    );
    expect(edited.isError, text(edited)).toBe(true);
    expect((await SecretModel.findById(bag.id))?.secret).toEqual({
      TOKEN: "original-value",
    });
    expect(
      (
        await InternalMcpCatalogModel.findById(catalog.id, {
          expandSecrets: false,
        })
      )?.localConfig,
    ).toEqual(config);
    const echo = await executeArchestraTool(
      `${prefix}edit_mcp_config`,
      {
        id: catalog.id,
        ...config,
        environment: [{ ...config.environment[0], value: "original-value" }],
      },
      context,
    );
    expect(echo.isError, text(echo)).toBe(false);
    expect(
      (
        await InternalMcpCatalogModel.findById(catalog.id, {
          expandSecrets: false,
        })
      )?.localConfigSecretId,
    ).toBe(bag.id);
  });

  test("registry administrator keeps custom runtime editing", async () => {
    context.userId = adminId;
    const result = await executeArchestraTool(
      `${prefix}edit_mcp_config`,
      {
        id: catalog.id,
        serviceAccount: "approved-runtime",
        envFrom: [{ type: "configMap", name: "approved-runtime-values" }],
      },
      context,
    );
    expect(result.isError, text(result)).toBe(false);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
        ?.serviceAccount,
    ).toBe("approved-runtime");
  });
});
