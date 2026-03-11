import { OrganizationModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("Organization agent settings", () => {
  test("sets default LLM model and provider", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    const updated = await OrganizationModel.patch(org.id, {
      defaultLlmModel: "gpt-4o",
      defaultLlmProvider: "openai",
    });

    expect(updated).not.toBeNull();
    expect(updated!.defaultLlmModel).toBe("gpt-4o");
    expect(updated!.defaultLlmProvider).toBe("openai");
  });

  test("sets default agent ID", async ({ makeOrganization, makeAgent }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });

    const updated = await OrganizationModel.patch(org.id, {
      defaultAgentId: agent.id,
    });

    expect(updated).not.toBeNull();
    expect(updated!.defaultAgentId).toBe(agent.id);
  });

  test("clears default agent ID with null", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });

    // Set a default agent first
    await OrganizationModel.patch(org.id, { defaultAgentId: agent.id });

    // Clear it
    const updated = await OrganizationModel.patch(org.id, {
      defaultAgentId: null,
    });

    expect(updated).not.toBeNull();
    expect(updated!.defaultAgentId).toBeNull();
  });

  test("updates all agent settings at once", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });

    const updated = await OrganizationModel.patch(org.id, {
      defaultLlmModel: "claude-opus-4-1-20250805",
      defaultLlmProvider: "anthropic",
      defaultAgentId: agent.id,
    });

    expect(updated).not.toBeNull();
    expect(updated!.defaultLlmModel).toBe("claude-opus-4-1-20250805");
    expect(updated!.defaultLlmProvider).toBe("anthropic");
    expect(updated!.defaultAgentId).toBe(agent.id);
  });

  test("getById returns defaultAgentId", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });

    await OrganizationModel.patch(org.id, { defaultAgentId: agent.id });

    const fetched = await OrganizationModel.getById(org.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.defaultAgentId).toBe(agent.id);
  });
});
