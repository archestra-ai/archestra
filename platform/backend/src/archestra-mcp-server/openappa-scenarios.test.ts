import { createHash } from "node:crypto";
import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import ToolModel from "@/models/tool";
import { initialPolicy } from "@/services/guardrails-policy";
import {
  getOpenAppaPolicyTests,
  updateOpenAppaPolicyTests,
} from "@/services/openappa-policy-tests";
import { draftOpenAppaScenario } from "@/services/openappa-scenario-discovery";
import { beforeEach, describe, expect, test } from "@/test";
import type { OpenAppaScenarioDiscovery } from "@/types/openappa-scenario-discovery";
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

describe("bounded scenario discovery", () => {
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
  async function discover() {
    const response = await executeArchestraTool(
      "archestra__discover_openappa_validation_scenarios",
      {},
      ctx,
    );
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    return response.structuredContent as OpenAppaScenarioDiscovery;
  }
  const select = (discoveryId: string, candidateId: string) =>
    executeArchestraTool(
      "archestra__draft_openappa_validation_scenario",
      { discoveryId, candidateId },
      ctx,
    );

  test("an unsaved starter offers policy setup instead of validations", async () => {
    expect(await discover()).toMatchObject({
      status: "setup_required",
      candidates: [],
      evaluated: 0,
    });
  });
  test("native decisions produce exact drafts without saving policy, suite or run history", async () => {
    await save();
    const result = await discover();
    expect(result.candidates, JSON.stringify(result)).toHaveLength(2);
    expect(
      result.candidates.map((c: { decision: string }) => c.decision),
    ).toEqual(["allow", "allow"]);
    const candidate = result.candidates[0];
    const response = await select(result.discoveryId, candidate.id);
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const draft = response.structuredContent as Awaited<
      ReturnType<typeof draftOpenAppaScenario>
    >;
    expect(draft).toMatchObject({
      file: { content: candidate.content },
      expectedRevision: 1,
      expectedVersion: "empty",
      tests: { draft: true },
    });
    expect(draft.tests.files[0].status).toBe("passed");
    expect(
      (await GuardrailsPolicyModel.findLatest(ctx.organizationId))?.revision,
    ).toBe(1);
    expect(
      await getOpenAppaPolicyTests(ctx.organizationId, ctx.userId),
    ).toMatchObject({ files: [], version: "empty" });
    expect(await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId)).toEqual(
      [],
    );
  });

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

  test("choices with the same tool leaf retain distinct identities and complete arguments", async () => {
    const payload = "x".repeat(1200);
    await save(`[policy]
version = 2
[[policy.tool]]
name = 'first__read'
parameters = { type = 'object', required = ['body'], properties = { body = { type = 'string', const = '${payload}' } } }
delta = {}
[[policy.tool]]
name = 'second__read'
delta = {}
`);
    const result = await discover();
    expect(result.candidates, JSON.stringify(result)).toHaveLength(2);
    expect(
      new Set(result.candidates.map((candidate) => candidate.id)).size,
    ).toBe(2);
    expect(result.candidates[0].arguments).toEqual({ body: payload });
    expect(result.candidates[0].content).toContain(payload);
  });

  test("selection rejects unknown choices and policy or suite changes", async () => {
    await save();
    const result = await discover();
    await expect(select(result.discoveryId, "invented")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      select("00000000-0000-4000-8000-000000000000", result.candidates[0].id),
    ).rejects.toMatchObject({ statusCode: 410 });
    await save(`${policy}\n# changed`, 1);
    const changedPolicy = await select(
      result.discoveryId,
      result.candidates[0].id,
    );
    expect(changedPolicy.isError).toBe(true);
    expect(JSON.stringify(changedPolicy.content)).toContain(
      "Policy or validations changed",
    );
    const fresh = await discover();
    await OpenAppaPolicyTestsModel.saveLocal({
      organizationId: ctx.organizationId,
      expectedVersion: "empty",
      files: [
        {
          path: "traces/existing.appa",
          content: "mcp/records/read {}\nexpect allow\n",
        },
      ],
    });
    const changedSuite = await select(
      fresh.discoveryId,
      fresh.candidates[0].id,
    );
    expect(changedSuite.isError).toBe(true);
    expect(JSON.stringify(changedSuite.content)).toContain(
      "Policy or validations changed",
    );
  });
  test("limited synthesis asks for input while other calls remain discoverable", async () => {
    await save(`${policy}
[[policy.tool]]
name = 'records__query'
parameters = { type = 'object', required = ['id'], properties = { id = { type = 'array', minItems = 4, items = { type = 'string' } } } }
delta = {}
`);
    const result = await discover();
    expect(result.candidates, JSON.stringify(result)).toHaveLength(2);
    expect(result.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "records__query",
          kind: "needs_input",
        }),
      ]),
    );
  });
  test("native replay applies deployment labels and alias bindings rather than inferred allow outcomes", async () => {
    await save(`[server_aliases]
mail = ['mail_prod']
[policy]
version = 2
[policy.deployment]
starting_label = { audience = ['internal'] }
[[policy.tool]]
name = 'mcp/mail/send(recipient:public/*)'
parameters = { type = 'object', required = ['body'], properties = { body = { type = 'string' } } }
delta = {}
requires = { audience = { contains = ['public'] } }
`);
    const result = await discover();
    expect(result.candidates, JSON.stringify(result)).toEqual([
      expect.objectContaining({
        tool: "mcp/mail_prod/send",
        arguments: { recipient: "public/example", body: "example" },
        decision: "deny",
      }),
    ]);
    expect(result.candidates[0].content).toContain(
      'recipient: "public/example"',
    );
  });
  test("model dependencies stop their branch while deterministic calls remain available", async () => {
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    await save(initialPolicy());
    const result = await discover();
    expect(result.candidates, JSON.stringify(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "mcp/archestra/ask_user",
          decision: "allow",
        }),
      ]),
    );
    expect(result.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "mcp/archestra/run_command",
          kind: "cannot_run",
        }),
      ]),
    );
  });
  test("cached selections cannot cross caller boundaries", async ({
    makeUser,
  }) => {
    await save();
    const result = await discover();
    const otherUser = await makeUser();
    await expect(
      draftOpenAppaScenario(
        { organizationId: ctx.organizationId, userId: otherUser.id },
        {
          discoveryId: result.discoveryId,
          candidateId: result.candidates[0].id,
        },
      ),
    ).rejects.toMatchObject({ statusCode: 410 });
  });
});
