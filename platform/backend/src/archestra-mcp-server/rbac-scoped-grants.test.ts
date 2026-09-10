// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { getArchestraToolFullName } from "@archestra/shared";
import AgentModel from "@/models/agent";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import { describe, expect, test } from "@/test";
import { executeArchestraTool } from ".";
import { filterToolNamesByPermission } from "./rbac";

describe("service account object grants over MCP", () => {
  test("a service account discovers and edits only its explicitly shared personal agent", async ({
    makeOrganization,
    makeCustomRole,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const role = await makeCustomRole(org.id, { permission: {} });
    const account = await ServiceAccountModel.create({
      organizationId: org.id,
      name: "Agent automation",
      role: role.role,
      createdBy: null,
    });
    const target = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "personal",
      authorId: owner.id,
      name: "Shared agent",
    });
    const other = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      scope: "org",
      authorId: owner.id,
    });
    await replacePolicy({
      organizationId: org.id,
      resource: "agent",
      scope: other.id,
      revision: 0,
      grants: [],
    });
    const context = {
      organizationId: org.id,
      userId: `service-account:${account.id}`,
      agent: { id: target.id, name: target.name },
    };
    await replacePolicy({
      organizationId: org.id,
      resource: "agent",
      scope: target.id,
      revision: 0,
      grants: [
        {
          subject: { type: "serviceAccount", id: account.id },
          actions: ["read", "update"],
        },
      ],
    });
    const names = [
      "list_agents",
      "get_agent",
      "edit_agent",
      "create_agent",
    ] as const;
    const tools = names.map(getArchestraToolFullName);
    expect(
      await filterToolNamesByPermission(tools, context.userId, org.id),
    ).toEqual(new Set(tools.slice(0, 3)));
    const listed = await executeArchestraTool(tools[0], {}, context);
    expect(listed.isError, JSON.stringify(listed)).toBe(false);
    expect(JSON.stringify(listed)).toContain(target.id);
    expect(JSON.stringify(listed)).not.toContain(other.id);
    for (const args of [{ id: target.id }, { name: target.name }]) {
      const found = await executeArchestraTool(tools[1], args, context);
      expect(found.isError, JSON.stringify(found)).toBe(false);
      expect(JSON.stringify(found)).toContain(target.id);
    }
    expect(
      (await executeArchestraTool(tools[1], { id: other.id }, context)).isError,
    ).toBe(true);
    const changed = await executeArchestraTool(
      tools[2],
      { id: target.id, name: "Edited shared agent" },
      context,
    );
    expect(changed.isError, JSON.stringify(changed)).toBe(false);
    expect((await AgentModel.findById(target.id))?.name).toBe(
      "Edited shared agent",
    );
    expect(
      (
        await executeArchestraTool(
          tools[2],
          { id: other.id, name: "Forbidden" },
          context,
        )
      ).isError,
    ).toBe(true);
  });

  test("discovers granted tools, edits only the granted object, and loses access when disabled", async ({
    makeOrganization,
    makeCustomRole,
    makeUser,
    makeAgent,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const role = await makeCustomRole(org.id, { permission: {} });
    const account = await ServiceAccountModel.create({
      organizationId: org.id,
      name: "Catalog automation",
      createdBy: null,
      role: role.role,
    });
    const agent = await makeAgent({ organizationId: org.id });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      authorId: author.id,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
    });
    const other = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      authorId: author.id,
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
    });
    const context = {
      organizationId: org.id,
      userId: `service-account:${account.id}`,
      agent: { id: agent.id, name: agent.name },
    };
    await replacePolicy({
      organizationId: org.id,
      resource: "mcpRegistry",
      scope: catalog.id,
      revision: 0,
      grants: [
        {
          subject: { type: "serviceAccount", id: account.id },
          actions: ["read", "update"],
        },
      ],
    });
    const edit = getArchestraToolFullName("edit_mcp_description");
    const list = getArchestraToolFullName("get_mcp_servers");
    const create = getArchestraToolFullName("create_mcp_server");
    expect(
      await filterToolNamesByPermission(
        [edit, list, create],
        context.userId,
        org.id,
      ),
    ).toEqual(new Set([edit, list]));
    const changed = await executeArchestraTool(
      edit,
      { id: catalog.id, description: "Scoped automation edit" },
      context,
    );
    expect(changed.isError, JSON.stringify(changed)).toBe(false);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.description,
    ).toBe("Scoped automation edit");
    const denied = await executeArchestraTool(
      edit,
      { id: other.id, description: "Forbidden edit" },
      context,
    );
    expect(denied.isError).toBe(true);
    expect(
      (await InternalMcpCatalogModel.findById(other.id))?.description,
    ).not.toBe("Forbidden edit");
    const listed = await executeArchestraTool(list, {}, context);
    expect(listed.isError, JSON.stringify(listed)).toBe(false);
    expect(JSON.stringify(listed)).toContain(catalog.id);
    expect(JSON.stringify(listed)).not.toContain(other.id);
    await ServiceAccountModel.update(account.id, org.id, { disabled: true });
    expect(
      await filterToolNamesByPermission(
        [edit, list, create],
        context.userId,
        org.id,
      ),
    ).toEqual(new Set());
    expect(
      (
        await executeArchestraTool(
          edit,
          { id: catalog.id, description: "Forbidden after disabling" },
          context,
        )
      ).isError,
    ).toBe(true);
  });
});

async function replacePolicy(
  params: Parameters<typeof ResourcePermissionPolicyModel.replace>[0],
) {
  const policy = await ResourcePermissionPolicyModel.find(params);
  const updated = await ResourcePermissionPolicyModel.replace({
    ...params,
    revision: policy?.revision ?? 0,
  });
  expect(updated).not.toBeNull();
  return updated;
}
