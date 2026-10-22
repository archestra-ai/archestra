import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import helperRoutes from "@/routes/openappa-helpers/openappa-helpers.routes";
import {
  GUARDRAILS_NOOP_ANNOTATOR_PATH,
  OPENAPPA_HELPERS_PREFIX,
} from "@/routes/route-paths";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, expect, onTestFinished, test } from "@/test";
import { executeArchestraTool } from ".";

const candidatePolicy = `[policy]
version = 2
[[policy.tool]]
name = 'files__read'
delta = { trust = 'suspicious' }
[[policy.tool]]
name = 'mail__send'
delta = {}
requires = { trust = 'trusted' }
`;
const existing = {
  path: "traces/fresh-send.appa",
  content:
    "# A fresh trusted session can send mail.\nmcp/mail/send {}\nexpect allow\n",
};
const regression = {
  path: "traces/external-send.appa",
  content:
    "# External data cannot be sent using a trusted-context write.\nmcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny\n",
};

beforeEach(() => {
  config.openappa.enabled = true;
});

test("the agent previews a validation against the saved policy and saves it without touching the policy or other checks", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id, { role: "admin" });
  const agent = await makeAgent({ organizationId: organization.id });
  await seedAndAssignArchestraTools(agent.id);
  await GuardrailsDeploymentModel.set({ enabled: false });
  await GuardrailsPolicyModel.save({
    organizationId: organization.id,
    content: candidatePolicy,
    contentHash: createHash("sha256").update(candidatePolicy).digest("hex"),
    updatedBy: user.id,
    expectedRevision: 0,
  });
  const initialSuite = await OpenAppaPolicyTestsModel.saveLocal({
    organizationId: organization.id,
    files: [existing],
    expectedVersion: "empty",
  });
  const context = {
    organizationId: organization.id,
    userId: user.id,
    agent: { id: agent.id, name: agent.name },
  };
  const request = {
    expectedRevision: 1,
    expectedVersion: initialSuite?.version,
    changes: { upsert: [regression], delete: [] },
  };
  const preview = await executeArchestraTool(
    "archestra__preview_guardrails_validation_change",
    request,
    context,
  );
  expect(preview.isError, JSON.stringify(preview.content)).not.toBe(true);
  // Only the new file is replayed, against the saved policy.
  expect(preview.structuredContent).toMatchObject({
    stage: "preview",
    policyRevision: 1,
    validation: { valid: true },
    tests: [{ path: regression.path, status: "passed" }],
  });
  const saved = await executeArchestraTool(
    "archestra__update_guardrails_validation",
    request,
    context,
  );
  expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true);
  expect(saved.structuredContent).toMatchObject({
    delivery: "revision",
    revision: 1,
    validation: { valid: true },
  });
  expect(await guardrailsPolicyService.get(organization.id)).toMatchObject({
    revision: 1,
    content: candidatePolicy,
  });
  expect((await OpenAppaPolicyTestsModel.find(organization.id))?.files).toEqual(
    [regression, existing],
  );
  expect((await GuardrailsDeploymentModel.get()).enabled).toBe(false);
  expect(await OpenAppaPolicyTestsModel.listRuns(organization.id)).toEqual([]);
});

test("validations save beside the unsaved starter policy without saving it or enabling enforcement", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id, { role: "admin" });
  const agent = await makeAgent({ organizationId: organization.id });
  await seedAndAssignArchestraTools(agent.id);
  await GuardrailsDeploymentModel.set({ enabled: false });
  const before = await guardrailsPolicyService.get(organization.id);
  const initialSuite = await OpenAppaPolicyTestsModel.saveLocal({
    organizationId: organization.id,
    files: [existing],
    expectedVersion: "empty",
  });
  const result = await executeArchestraTool(
    "archestra__update_guardrails_validation",
    {
      expectedRevision: before.revision,
      expectedVersion: initialSuite?.version,
      changes: { upsert: [regression] },
    },
    {
      organizationId: organization.id,
      userId: user.id,
      agent: { id: agent.id, name: agent.name },
    },
  );
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    delivery: "revision",
    revision: 0,
  });
  expect(await GuardrailsPolicyModel.findLatest(organization.id)).toBeNull();
  expect((await GuardrailsDeploymentModel.get()).enabled).toBe(false);
  expect((await OpenAppaPolicyTestsModel.find(organization.id))?.files).toEqual(
    [regression, existing],
  );
});

test("the validation tools refuse policy text", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id, { role: "admin" });
  const agent = await makeAgent({ organizationId: organization.id });
  await seedAndAssignArchestraTools(agent.id);
  for (const name of [
    "preview_guardrails_validation_change",
    "update_guardrails_validation",
  ]) {
    const result = await executeArchestraTool(
      `archestra__${name}`,
      {
        expectedRevision: 0,
        expectedVersion: "empty",
        changes: { upsert: [existing] },
        policyContent: candidatePolicy,
      },
      {
        organizationId: organization.id,
        userId: user.id,
        agent: { id: agent.id, name: agent.name },
      },
    );
    expect(result.isError).toBe(true);
  }
  expect(await GuardrailsPolicyModel.findLatest(organization.id)).toBeNull();
  expect(await OpenAppaPolicyTestsModel.find(organization.id)).toBeNull();
});

test("readers can inspect and preview but cannot publish specifications", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeCustomRole,
  makeAgent,
  seedAndAssignArchestraTools,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  const reader = await makeCustomRole(organization.id, {
    permission: { guardrailsPolicy: ["read"] },
  });
  await makeMember(user.id, organization.id, { role: reader.role });
  const agent = await makeAgent({ organizationId: organization.id });
  await seedAndAssignArchestraTools(agent.id);
  const context = {
    organizationId: organization.id,
    userId: user.id,
    agent: { id: agent.id, name: agent.name },
  };
  const read = await executeArchestraTool(
    "archestra__get_openappa_policy_tests",
    {},
    context,
  );
  expect(read.isError).not.toBe(true);
  const request = {
    expectedRevision: 0,
    expectedVersion: "empty",
    changes: { upsert: [existing] },
  };
  const preview = await executeArchestraTool(
    "archestra__preview_guardrails_validation_change",
    request,
    context,
  );
  expect(preview.isError, JSON.stringify(preview.content)).not.toBe(true);
  const denied = await executeArchestraTool(
    "archestra__update_guardrails_validation",
    request,
    context,
  );
  expect(denied.isError).toBe(true);
  const runDenied = await executeArchestraTool(
    "archestra__run_openappa_policy_tests",
    {},
    context,
  );
  expect(runDenied.isError).toBe(true);
  expect(await OpenAppaPolicyTestsModel.listRuns(organization.id)).toEqual([]);
  expect(await OpenAppaPolicyTestsModel.find(organization.id)).toBeNull();
});

test("stale suite versions yield recoverable conflicts and write nothing", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id, { role: "admin" });
  const agent = await makeAgent({ organizationId: organization.id });
  await seedAndAssignArchestraTools(agent.id);
  for (const name of [
    "preview_guardrails_validation_change",
    "update_guardrails_validation",
  ]) {
    const result = await executeArchestraTool(
      `archestra__${name}`,
      {
        expectedRevision: 0,
        expectedVersion: "outdated",
        changes: { upsert: [existing] },
      },
      {
        organizationId: organization.id,
        userId: user.id,
        agent: { id: agent.id, name: agent.name },
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("read both again") },
    ]);
  }
  expect(await GuardrailsPolicyModel.findLatest(organization.id)).toBeNull();
  expect(await OpenAppaPolicyTestsModel.find(organization.id)).toBeNull();
});

test("a policy preview replays the saved validations against the proposed policy without recording a run", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id, { role: "admin" });
  const agent = await makeAgent({ organizationId: organization.id });
  await seedAndAssignArchestraTools(agent.id);
  await GuardrailsPolicyModel.save({
    organizationId: organization.id,
    content: candidatePolicy,
    contentHash: createHash("sha256").update(candidatePolicy).digest("hex"),
    updatedBy: user.id,
    expectedRevision: 0,
  });
  await OpenAppaPolicyTestsModel.saveLocal({
    organizationId: organization.id,
    files: [existing, regression],
    expectedVersion: "empty",
  });
  // Dropping the trust requirement lets mail go out after a suspicious read.
  const loosened = candidatePolicy.replace(
    "requires = { trust = 'trusted' }\n",
    "",
  );
  const preview = await executeArchestraTool(
    "archestra__preview_guardrails_policy_change",
    { content: loosened, expectedRevision: 1 },
    {
      organizationId: organization.id,
      userId: user.id,
      agent: { id: agent.id, name: agent.name },
    },
  );
  expect(preview.isError, JSON.stringify(preview.content)).not.toBe(true);
  expect(preview.structuredContent?.validations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: existing.path, status: "passed" }),
      expect.objectContaining({ path: regression.path, status: "failed" }),
    ]),
  );
  expect(
    (await GuardrailsPolicyModel.findLatest(organization.id))?.content,
  ).toBe(candidatePolicy);
  expect(await OpenAppaPolicyTestsModel.listRuns(organization.id)).toEqual([]);
});

test("a policy preview runs the draft's battery helpers for a caller who may change the policy, and only for them", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeCustomRole,
  makeTeam,
  makeTeamMember,
  makeAgent,
  seedAndAssignArchestraTools,
}) => {
  const organization = await makeOrganization();
  const editor = await makeUser();
  await makeMember(editor.id, organization.id, { role: "admin" });
  const viewer = await makeUser();
  const reader = await makeCustomRole(organization.id, {
    permission: { guardrailsPolicy: ["read"] },
  });
  await makeMember(viewer.id, organization.id, { role: reader.role });
  const agent = await makeAgent({ organizationId: organization.id });
  await seedAndAssignArchestraTools(agent.id);
  const team = await makeTeam(organization.id, editor.id);
  await makeTeamMember(team.id, editor.id);
  const consulted = await serveHelperBridge();
  // After reading organization-internal data, sharing a project with a team needs that team's
  // members, which the archestra battery's audience source answers.
  const share = {
    path: "traces/share.appa",
    content: `mcp/notes/read {}\nexpect allow\nmcp/archestra/set_project_share {\n  visibility: "team"\n  team_ids: ["${team.id}"]\n}\nexpect allow\n`,
  };
  await OpenAppaPolicyTestsModel.saveLocal({
    organizationId: organization.id,
    files: [share],
    expectedVersion: "empty",
  });
  // Nothing is saved yet, so the draft's battery has no install row.
  const draft = `include = ["batteries/archestra/appa.toml"]

[aliases.mcp]
archestra = ["archestra"]

[policy]
version = 2

[policy.audience]
internal = ["archestra:members"]

[[policy.tool]]
name = "notes__read"
delta = { audience = ["internal"] }
`;
  const preview = (userId: string) =>
    executeArchestraTool(
      "archestra__preview_guardrails_policy_change",
      { content: draft, expectedRevision: 0 },
      {
        organizationId: organization.id,
        userId,
        agent: { id: agent.id, name: agent.name },
      },
    );

  const edited = await preview(editor.id);
  expect(edited.isError, JSON.stringify(edited.content)).not.toBe(true);
  expect(edited.structuredContent?.validations).toEqual([
    expect.objectContaining({ path: share.path, status: "passed" }),
  ]);
  // Each consult named a temporary install id the bridge answered.
  expect(consulted.length).toBeGreaterThan(0);
  for (const { installId, statusCode } of consulted) {
    expect(installId).not.toBe("checked");
    expect(statusCode).toBe(200);
  }

  consulted.length = 0;
  const viewed = await preview(viewer.id);
  expect(viewed.isError, JSON.stringify(viewed.content)).not.toBe(true);
  expect(viewed.structuredContent?.validations).toEqual([
    expect.objectContaining({ path: share.path, status: "cannot_run" }),
  ]);
  // A viewer's replay names only the placeholder, which the bridge refuses.
  expect(consulted.length).toBeGreaterThan(0);
  expect(consulted).toEqual(
    consulted.map(() => ({ installId: "checked", statusCode: 400 })),
  );
  expect(await GuardrailsPolicyModel.findLatest(organization.id)).toBeNull();
});

/**
 * This process's loopback endpoints a replay consults: the real battery
 * helper route, and the no-op annotator. Records each helper consult.
 */
async function serveHelperBridge() {
  const consulted: { installId: string; statusCode: number }[] = [];
  const app = createFastifyInstance();
  await app.register(helperRoutes);
  app.post(GUARDRAILS_NOOP_ANNOTATOR_PATH, async () =>
    guardrailsPolicyService.annotate(),
  );
  app.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith(OPENAPPA_HELPERS_PREFIX))
      consulted.push({
        installId: request.url
          .slice(OPENAPPA_HELPERS_PREFIX.length + 1)
          .split("/")[0],
        statusCode: reply.statusCode,
      });
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = config.api.port;
  config.api.port = (app.server.address() as AddressInfo).port;
  onTestFinished(async () => {
    config.api.port = port;
    await app.close();
  });
  return consulted;
}
