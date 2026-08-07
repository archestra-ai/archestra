// biome-ignore-all lint/suspicious/noExplicitAny: test
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { InternalMcpCatalogModel } from "@/models";
import SecretModel from "@/models/secret";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const EDIT_CONFIG_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_config`;
const CREATE_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server`;

/** Distinctive so an assertion failure names the exact value that escaped. */
const SECRET_VALUE = "sk-netbox-PLAINTEXT-must-not-escape";
const REGCRED_PASSWORD = "regcred-PLAINTEXT-must-not-escape";
const CLIENT_SECRET = "oauth-client-PLAINTEXT-must-not-escape";

function resultText(result: { content: unknown[] }): string {
  return (result.content as any[]).map((c) => c?.text ?? "").join("\n");
}

describe("archestra MCP catalog tools do not leak secrets", () => {
  let testAgent: Agent;
  let mockContext: ArchestraContext;
  let organizationId: string;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({ name: "Test Agent", organizationId: org.id });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

  /**
   * Builds a catalog item in the shape the REST route produces: the secret
   * value lives in the secret bag and is absent from the localConfig template.
   */
  async function makeCatalogWithVaultedSecret(
    makeInternalMcpCatalog: any,
    extraLocalConfig: Record<string, unknown> = {},
  ) {
    const secret = await SecretModel.create({
      name: `netbox-${crypto.randomUUID().slice(0, 8)}`,
      secret: { NETBOX_TOKEN: SECRET_VALUE },
    });
    const catalog = await makeInternalMcpCatalog({
      name: `netbox-${crypto.randomUUID().slice(0, 8)}`,
      serverType: "local",
      organizationId,
      localConfigSecretId: secret.id,
      localConfig: {
        command: "echo",
        environment: [
          {
            key: "NETBOX_TOKEN",
            type: "secret",
            promptOnInstallation: false,
            required: false,
          },
        ],
        ...extraLocalConfig,
      },
    });
    return { catalog, secret };
  }

  test("edit_mcp_config touching only command neither echoes nor persists a vaulted secret", async ({
    makeInternalMcpCatalog,
  }) => {
    const { catalog } = await makeCatalogWithVaultedSecret(
      makeInternalMcpCatalog,
    );

    // The caller never supplies the secret and never mentions `environment`.
    const result = await executeArchestraTool(
      EDIT_CONFIG_TOOL,
      { id: catalog.id, command: "echo-CHANGED" },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(resultText(result as any)).not.toContain(SECRET_VALUE);

    const stored = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    // The edit itself must still apply ...
    expect(stored?.localConfig?.command).toBe("echo-CHANGED");
    // ... without re-inflating the vaulted value into the stored template.
    expect(stored?.localConfig?.environment?.[0].value).toBeUndefined();
    expect(JSON.stringify(stored?.localConfig)).not.toContain(SECRET_VALUE);
  });

  test("edit_mcp_config vaults a caller-supplied secret instead of storing it inline", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: `inline-${crypto.randomUUID().slice(0, 8)}`,
      serverType: "local",
      organizationId,
      localConfig: { command: "echo" },
    });

    const result = await executeArchestraTool(
      EDIT_CONFIG_TOOL,
      {
        id: catalog.id,
        environment: [
          {
            key: "NETBOX_TOKEN",
            type: "secret",
            value: SECRET_VALUE,
            promptOnInstallation: false,
          },
        ],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(resultText(result as any)).not.toContain(SECRET_VALUE);

    const stored = await InternalMcpCatalogModel.findById(catalog.id, {
      expandSecrets: false,
    });
    expect(stored?.localConfig?.environment?.[0].value).toBeUndefined();
    expect(stored?.localConfigSecretId).toBeTruthy();

    // The value is recoverable from the bag, so the edit was not simply dropped.
    const bag = await SecretModel.findById(stored?.localConfigSecretId ?? "");
    expect(bag?.secret.NETBOX_TOKEN).toBe(SECRET_VALUE);
  });

  test("create_mcp_server vaults a caller-supplied secret instead of storing it inline", async () => {
    const result = await executeArchestraTool(
      CREATE_TOOL,
      {
        name: `created-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "local",
        command: "echo",
        environment: [
          {
            key: "NETBOX_TOKEN",
            type: "secret",
            value: SECRET_VALUE,
            promptOnInstallation: false,
          },
        ],
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(resultText(result as any)).not.toContain(SECRET_VALUE);

    const idMatch = resultText(result as any).match(/ID: ([0-9a-f-]{36})/);
    expect(idMatch).toBeTruthy();
    const stored = await InternalMcpCatalogModel.findById(idMatch?.[1] ?? "", {
      expandSecrets: false,
    });
    expect(stored?.localConfig?.environment?.[0].value).toBeUndefined();
    expect(stored?.localConfigSecretId).toBeTruthy();

    const bag = await SecretModel.findById(stored?.localConfigSecretId ?? "");
    expect(bag?.secret.NETBOX_TOKEN).toBe(SECRET_VALUE);
  });

  test("create_mcp_server does not store an OAuth client secret inline", async () => {
    const result = await executeArchestraTool(
      CREATE_TOOL,
      {
        name: `oauth-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "remote",
        serverUrl: "https://api.example.com/mcp/",
        oauthConfig: {
          name: "example",
          server_url: "https://api.example.com/mcp/",
          client_id: "abc",
          client_secret: CLIENT_SECRET,
          redirect_uris: ["https://api.example.com/callback"],
          scopes: ["read"],
          default_scopes: ["read"],
          supports_resource_metadata: false,
        },
      },
      mockContext,
    );

    expect(result.isError).toBe(false);
    expect(resultText(result as any)).not.toContain(CLIENT_SECRET);

    const idMatch = resultText(result as any).match(/ID: ([0-9a-f-]{36})/);
    const stored = await InternalMcpCatalogModel.findById(idMatch?.[1] ?? "", {
      expandSecrets: false,
    });
    expect(JSON.stringify(stored?.oauthConfig)).not.toContain(CLIENT_SECRET);
  });

  /**
   * The MCP surface never accepted the `credentials` variant that carries a
   * registry password, and `expandSecrets` re-inflates only `environment[]` —
   * so regcred passwords cannot reach a tool result. Widening this schema
   * without adding extraction would open that path.
   */
  test("create_mcp_server rejects image pull secret credentials", async () => {
    const result = await executeArchestraTool(
      CREATE_TOOL,
      {
        name: `regcred-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "local",
        dockerImage: "registry.example.com/private/mcp:1",
        imagePullSecrets: [
          {
            source: "credentials",
            server: "registry.example.com",
            username: "robot",
            password: REGCRED_PASSWORD,
          },
        ],
      },
      mockContext,
    );

    expect(result.isError).toBe(true);
    expect(resultText(result as any)).not.toContain(REGCRED_PASSWORD);
  });
});
