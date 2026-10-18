import { createHash } from "node:crypto";
import config from "@/config";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, expect, test } from "@/test";
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
