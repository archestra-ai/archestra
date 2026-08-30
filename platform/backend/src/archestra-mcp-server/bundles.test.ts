// biome-ignore-all lint/suspicious/noExplicitAny: MCP result assertions
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import { PluginModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    bundles: { enabled: true },
  }),
);

vi.mock("@/auth/utils");

import { userHasPermission } from "@/auth/utils";

const toolName = (shortName: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${shortName}`;

describe("bundle tool execution", () => {
  let context: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    const agent: Agent = await makeAgent({
      name: "Bundle manager",
      organizationId: organization.id,
    });
    context = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId: organization.id,
    };
    config.bundles.enabled = true;
    vi.mocked(userHasPermission).mockResolvedValue(true);
  });

  test("creates and lists a bundle", async () => {
    const createResult = await executeArchestraTool(
      toolName("create_bundle"),
      {
        name: "Designer",
        description: "Creative workflow",
        skill_ids: [],
        plugin_ids: [],
        mcp_gateway_id: null,
      },
      context,
    );
    expect(createResult.isError).not.toBe(true);
    expect((createResult.structuredContent as any).bundle.name).toBe(
      "Designer",
    );

    const listResult = await executeArchestraTool(
      toolName("list_bundles"),
      {},
      context,
    );
    expect(listResult.isError).not.toBe(true);
    expect((listResult.structuredContent as any).bundles).toHaveLength(1);
  });

  test("hides discovery and rejects direct calls while Bundles are disabled", async () => {
    config.bundles.enabled = false;
    const { getArchestraMcpTools } = await import(".");

    expect(getArchestraMcpTools().map((tool) => tool.name)).not.toContain(
      toolName("list_bundles"),
    );

    const result = await executeArchestraTool(
      toolName("list_bundles"),
      {},
      context,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "Bundles are not enabled",
    );
  });

  test("rejects executable plugin membership without plugin:admin", async () => {
    const organizationId = context.organizationId;
    const userId = context.userId;
    if (!organizationId || !userId) {
      throw new Error("organization and user context required");
    }
    const plugin = await PluginModel.create({
      organizationId,
      userId,
      input: {
        displayName: "Bundle Hook",
        description: "Executable bundle membership",
        clientType: "claude-code",
        files: [
          {
            path: "hooks/hooks.json",
            content: "{}\n",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
    });
    if (!plugin) throw new Error("failed to seed plugin");
    vi.mocked(userHasPermission).mockImplementation(
      async (_userId, _organizationId, resource, action) =>
        !(resource === "plugin" && action === "admin"),
    );

    const result = await executeArchestraTool(
      toolName("create_bundle"),
      {
        name: "Restricted",
        description: "Must not admit executable payloads",
        plugin_ids: [plugin.id],
      },
      context,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "approved plugins were not found",
    );
  });
});
