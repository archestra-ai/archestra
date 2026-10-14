import { createHash } from "node:crypto";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import {
  getOpenAppaPolicyTests,
  updateOpenAppaPolicyTests,
} from "@/services/openappa-policy-tests";
import { beforeEach, describe, expect, test } from "@/test";
import { executeArchestraTool } from ".";

const policy = `[policy]
version = 2
[[policy.tool]]
name = 'records__read'
delta = {}
[[policy.tool]]
name = 'records__delete'
requires = { audience = { contains = ['internal'] } }
delta = {}
`;

describe("run_openappa_policy_tests", () => {
  let ctx: {
    organizationId: string;
    userId: string;
    agent: { id: string; name: string };
  };
  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      seedAndAssignArchestraTools,
    }) => {
      config.openappa.enabled = true;
      const organization = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, organization.id, { role: "admin" });
      const agent = await makeAgent({ organizationId: organization.id });
      await seedAndAssignArchestraTools(agent.id);
      ctx = {
        organizationId: organization.id,
        userId: user.id,
        agent: { id: agent.id, name: agent.name },
      };
    },
  );
  async function save(content = policy, expectedRevision = 0) {
    await GuardrailsPolicyModel.save({
      organizationId: ctx.organizationId,
      updatedBy: ctx.userId,
      expectedRevision,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
    });
  }

  test("running saved checks records native results without changing the policy or suite", async () => {
    await save();
    await expect(
      executeArchestraTool("archestra__run_openappa_policy_tests", {}, ctx),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId)).toEqual(
      [],
    );
    const suite = await updateOpenAppaPolicyTests({
      organizationId: ctx.organizationId,
      expectedVersion: "empty",
      files: [
        {
          path: "traces/allowed.appa",
          content: "mcp/records/read {}\nexpect allow\n",
        },
        {
          path: "traces/failing.appa",
          content: "mcp/records/read {}\nexpect deny\n",
        },
      ],
    });
    const response = await executeArchestraTool(
      "archestra__run_openappa_policy_tests",
      {},
      ctx,
    );
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const runs = await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId);
    expect(runs).toHaveLength(1);
    expect(response.structuredContent).toMatchObject({
      id: runs[0].id,
      stale: false,
      files: [
        expect.objectContaining({ status: "passed" }),
        expect.objectContaining({ status: "failed" }),
      ],
    });
    expect(
      await getOpenAppaPolicyTests(ctx.organizationId, ctx.userId),
    ).toMatchObject({ version: suite.version, files: suite.files });
    expect(
      (await GuardrailsPolicyModel.findLatest(ctx.organizationId))?.revision,
    ).toBe(1);
  });
});
