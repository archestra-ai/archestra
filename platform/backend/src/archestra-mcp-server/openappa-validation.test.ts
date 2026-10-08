import { createHash } from "node:crypto";
import config from "@/config";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, expect, test } from "@/test";
import { executeArchestraTool } from ".";

const originalPolicy = `[policy]
version = 2
[[policy.tool]]
name = 'files__read'
delta = {}
[[policy.tool]]
name = 'mail__send'
delta = {}
`;
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

test("the agent previews against a proposed policy and saves the patch without losing unrelated checks", async ({
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
  const context = {
    organizationId: organization.id,
    userId: user.id,
    agent: { id: agent.id, name: agent.name },
  };
  await GuardrailsPolicyModel.save({
    organizationId: organization.id,
    content: originalPolicy,
    contentHash: createHash("sha256").update(originalPolicy).digest("hex"),
    updatedBy: user.id,
    expectedRevision: 0,
  });
  const initialSuite = await OpenAppaPolicyTestsModel.saveLocal({
    organizationId: organization.id,
    files: [existing],
    expectedVersion: "empty",
  });
  const read = await executeArchestraTool(
    "archestra__get_openappa_policy_tests",
    {},
    context,
  );
  expect(read.isError).not.toBe(true);
  expect(read.structuredContent).toMatchObject({
    source: "local",
    version: initialSuite?.version,
    files: [existing],
  });
  const request = {
    expectedRevision: 1,
    expectedVersion: initialSuite?.version,
    changes: { upsert: [regression], delete: [] },
    policyContent: candidatePolicy,
  };
  const preview = await executeArchestraTool(
    "archestra__preview_openappa_validation_change",
    request,
    context,
  );
  expect(preview.isError, JSON.stringify(preview.content)).not.toBe(true);
  expect(preview.structuredContent).toMatchObject({
    stage: "preview",
    policy: { before: originalPolicy, after: candidatePolicy, changed: true },
    counts: { passed: 2, failed: 0, cannotRun: 0 },
    tests: { draft: true },
  });
  expect(
    (await GuardrailsPolicyModel.findLatest(organization.id))?.content,
  ).toBe(originalPolicy);
  expect((await OpenAppaPolicyTestsModel.find(organization.id))?.files).toEqual(
    [existing],
  );
  const publish = await executeArchestraTool(
    "archestra__publish_openappa_validation_change",
    request,
    context,
  );
  expect(publish.isError, JSON.stringify(publish.content)).not.toBe(true);
  expect(publish.structuredContent).toMatchObject({
    delivery: "revision",
    revision: 2,
    policyChanged: true,
    counts: { passed: 2, failed: 0, cannotRun: 0 },
  });
  expect(
    (await GuardrailsPolicyModel.findLatest(organization.id))?.content,
  ).toBe(candidatePolicy);
  expect((await OpenAppaPolicyTestsModel.find(organization.id))?.files).toEqual(
    [regression, existing],
  );
  expect(await OpenAppaPolicyTestsModel.listRuns(organization.id)).toEqual([]);
});

test("specification-only writes preserve unrelated checks and policy without enabling enforcement", async ({
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
    "archestra__publish_openappa_validation_change",
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
    policyChanged: false,
    revision: 0,
  });
  expect(await GuardrailsPolicyModel.findLatest(organization.id)).toBeNull();
  expect((await GuardrailsDeploymentModel.get()).enabled).toBe(false);
  expect((await OpenAppaPolicyTestsModel.find(organization.id))?.files).toEqual(
    [regression, existing],
  );
  expect(await OpenAppaPolicyTestsModel.listRuns(organization.id)).toEqual([]);
});

test("a first combined policy save enables enforcement even with informational failed checks", async ({
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
  const result = await executeArchestraTool(
    "archestra__publish_openappa_validation_change",
    {
      expectedRevision: 0,
      expectedVersion: "empty",
      policyContent: originalPolicy,
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
    revision: 1,
    policyChanged: true,
    counts: { passed: 0, failed: 1, cannotRun: 0 },
    enforcement: { enabled: true, turnedOn: true },
  });
  expect((await GuardrailsDeploymentModel.get()).enabled).toBe(true);
});

test("explicitly publishing the unchanged first starter with specifications saves and enables it", async ({
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
  const starter = await guardrailsPolicyService.get(organization.id);
  expect(starter.revision).toBe(0);
  const result = await executeArchestraTool(
    "archestra__publish_openappa_validation_change",
    {
      expectedRevision: 0,
      expectedVersion: "empty",
      policyContent: starter.content,
      changes: { upsert: [existing] },
    },
    {
      organizationId: organization.id,
      userId: user.id,
      agent: { id: agent.id, name: agent.name },
    },
  );
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    revision: 1,
    policyChanged: true,
    enforcement: { enabled: true, turnedOn: true },
  });
  expect(
    (await GuardrailsPolicyModel.findLatest(organization.id))?.content,
  ).toBe(starter.content);
  expect((await OpenAppaPolicyTestsModel.find(organization.id))?.files).toEqual(
    [existing],
  );
  expect((await GuardrailsDeploymentModel.get()).enabled).toBe(true);
  expect(await OpenAppaPolicyTestsModel.listRuns(organization.id)).toEqual([]);
});

test("readers can inspect and preview but cannot publish specifications", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  seedAndAssignArchestraTools,
}) => {
  const organization = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, organization.id, { role: "member" });
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
    "archestra__preview_openappa_validation_change",
    request,
    context,
  );
  expect(preview.isError, JSON.stringify(preview.content)).not.toBe(true);
  const denied = await executeArchestraTool(
    "archestra__publish_openappa_validation_change",
    request,
    context,
  );
  expect(denied.isError).toBe(true);
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
    "preview_openappa_validation_change",
    "publish_openappa_validation_change",
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
