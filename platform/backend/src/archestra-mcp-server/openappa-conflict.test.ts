import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import { expect, test } from "@/test";
import { executeArchestraTool } from ".";

for (const toolName of [
  "preview_guardrails_policy_change",
  "update_guardrails_policy",
]) {
  test(`${toolName} returns a recoverable tool result for a stale revision`, async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    config.openappa.enabled = true;
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    await seedAndAssignArchestraTools(agent.id);
    const result = await executeArchestraTool(
      `archestra__${toolName}`,
      {
        content: "[policy]\nversion = 2\n",
        expectedRevision: 999,
        ...(toolName === "update_guardrails_policy"
          ? { title: "Policy change", summary: "Review policy" }
          : {}),
      },
      {
        agent: { id: agent.id, name: agent.name },
        organizationId: org.id,
        userId: user.id,
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("The policy changed. Read it again"),
      },
    ]);
    expect(await GuardrailsPolicyModel.findLatest(org.id)).toBeNull();
  });
}
