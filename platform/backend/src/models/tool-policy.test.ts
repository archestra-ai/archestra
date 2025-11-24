import { describe, expect, test } from "@/test";
import AgentToolModel from "./agent-tool";
import ToolPolicyModel from "./tool-policy";

describe("ToolPolicyModel", () => {
  test("creates and retrieves a tool policy", async ({
    makeOrganization,
    makeTool,
  }) => {
    const organization = await makeOrganization();
    const tool = await makeTool();

    const created = await ToolPolicyModel.create({
      name: "Policy for testing",
      toolId: tool.id,
      organizationId: organization.id,
      allowUsageWhenUntrustedDataIsPresent: true,
      toolResultTreatment: "trusted",
      responseModifierTemplate: "modify response",
    });

    const fetched = await ToolPolicyModel.findById(created.id);

    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe(created.name);
    expect(fetched?.toolId).toBe(tool.id);
    expect(fetched?.organizationId).toBe(organization.id);
    expect(fetched?.allowUsageWhenUntrustedDataIsPresent).toBe(true);
    expect(fetched?.toolResultTreatment).toBe("trusted");
    expect(fetched?.responseModifierTemplate).toBe("modify response");
  });

  test("search filters by tool and organization", async ({
    makeOrganization,
    makeTool,
  }) => {
    const organization = await makeOrganization();
    const anotherOrganization = await makeOrganization();
    const tool = await makeTool();
    const otherTool = await makeTool();

    await ToolPolicyModel.create({
      name: "Primary policy",
      toolId: tool.id,
      organizationId: organization.id,
      allowUsageWhenUntrustedDataIsPresent: false,
      toolResultTreatment: "untrusted",
    });

    await ToolPolicyModel.create({
      name: "Other policy",
      toolId: otherTool.id,
      organizationId: anotherOrganization.id,
      allowUsageWhenUntrustedDataIsPresent: false,
      toolResultTreatment: "untrusted",
    });

    const { data, pagination } = await ToolPolicyModel.search(
      { limit: 10, offset: 0 },
      {
        toolId: tool.id,
        organizationId: organization.id,
      },
    );

    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Primary policy");
    expect(pagination.total).toBe(1);
  });

  test("findByAgentTool returns linked policy", async ({
    makeOrganization,
    makeTool,
    makeAgent,
  }) => {
    const organization = await makeOrganization();
    const tool = await makeTool();
    const policy = await ToolPolicyModel.create({
      name: "Linked policy",
      toolId: tool.id,
      organizationId: organization.id,
      allowUsageWhenUntrustedDataIsPresent: true,
      toolResultTreatment: "sanitize_with_dual_llm",
    });

    const agent = await makeAgent();
    const agentTool = await AgentToolModel.create(agent.id, tool.id, {
      toolPolicyId: policy.id,
    });

    const found = await ToolPolicyModel.findByAgentTool(agentTool.id);

    expect(found?.id).toBe(policy.id);
    expect(found?.toolResultTreatment).toBe("sanitize_with_dual_llm");
  });
});
