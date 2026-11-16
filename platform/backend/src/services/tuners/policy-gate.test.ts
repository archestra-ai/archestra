import { createHash } from "node:crypto";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { ARCHESTRA_BATTERY } from "@/openappa/archestra-audience";
import { bundledEntry } from "@/openappa/declarations";
import { initialPolicy } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import type { GuardrailsPolicyEdit } from "@/types/guardrails-policy-proposal";
import type { PolicyTestFile } from "@/types/openappa-policy-tests";
import { checkPolicyChange } from "./policy-gate";

const POLICY = `[policy]
version = 2
[[policy.tool]]
name = 'files__read'
delta = { trust = 'suspicious' }
[[policy.tool]]
name = 'mail__send'
delta = {}
requires = { trust = 'trusted' }
`;
const FRESH_SEND: PolicyTestFile = {
  path: "traces/fresh-send.appa",
  content: "mcp/mail/send {}\nexpect allow\n",
};
const EXTERNAL_SEND: PolicyTestFile = {
  path: "traces/external-send.appa",
  content: "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny\n",
};
const ADD_RULE = {
  oldText: "[[policy.tool]]\nname = 'mail__send'\n",
  newText:
    "[[policy.tool]]\nname = 'notes__read'\ndelta = {}\n[[policy.tool]]\nname = 'mail__send'\n",
};
const DROP_TRUST = {
  oldText: "requires = { trust = 'trusted' }\n",
  newText: "",
};

let organizationId: string;
let userId: string;

beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
  config.openappa.enabled = true;
  organizationId = (await makeOrganization()).id;
  userId = (await makeUser()).id;
  await makeMember(userId, organizationId, { role: "admin" });
});

describe("checkPolicyChange", () => {
  test("a revision other than the current one is stale", async () => {
    await savePolicy(POLICY);
    const outcome = await checkPolicyChange({
      organizationId,
      userId,
      expectedRevision: 0,
      edits: [ADD_RULE],
    });
    expect(outcome).toMatchObject({
      type: "rejected",
      reason: "stale_revision",
    });
    await expectNothingWritten({ revision: 1, suite: null });
  });

  test("an edit whose text is not in the policy is not applicable", async () => {
    await savePolicy(POLICY);
    const outcome = await checkPolicyChange({
      organizationId,
      userId,
      expectedRevision: 1,
      edits: [{ oldText: "name = 'not_there'", newText: "x" }],
    });
    expect(outcome).toMatchObject({
      type: "rejected",
      reason: "edit_not_applicable",
    });
  });

  test("a [credentials] line for a battery variable is refused", async () => {
    await savePolicy(withGithubBattery());
    const outcome = await checkPolicyChange({
      organizationId,
      userId,
      expectedRevision: 1,
      edits: [
        {
          oldText: "[externals]\n",
          newText:
            '[credentials]\nAPPA_PROVIDER_GITHUB_TOKEN = "github-token"\n\n[externals]\n',
        },
      ],
    });
    expect(outcome).toMatchObject({
      type: "rejected",
      reason: "credential_line",
    });
  });

  test("an include no battery answers makes the policy invalid", async () => {
    await savePolicy(POLICY);
    const outcome = await checkPolicyChange({
      organizationId,
      userId,
      expectedRevision: 1,
      edits: [
        {
          oldText: "[policy]\n",
          newText:
            'include = ["batteries/no-such-battery/appa.toml"]\n[policy]\n',
        },
      ],
    });
    expect(outcome).toMatchObject({
      type: "rejected",
      reason: "invalid_policy",
    });
  });

  test("a change a saved validation fails is refused and names only that file", async () => {
    await savePolicy(POLICY);
    const suite = await saveSuite([FRESH_SEND, EXTERNAL_SEND]);
    const outcome = await checkPolicyChange({
      organizationId,
      userId,
      expectedRevision: 1,
      edits: [DROP_TRUST],
    });
    expect(outcome).toMatchObject({
      type: "rejected",
      reason: "validation_failed",
    });
    if (outcome.type !== "rejected") throw new Error("expected a rejection");
    expect(outcome.message).toContain(EXTERNAL_SEND.path);
    expect(outcome.message).not.toContain(FRESH_SEND.path);
    await expectNothingWritten({ revision: 1, suite });
  });

  test("with no saved validations the change is accepted unverified", async () => {
    await savePolicy(POLICY);
    const outcome = await checkPolicyChange({
      organizationId,
      userId,
      expectedRevision: 1,
      edits: [DROP_TRUST],
    });
    expect(outcome).toEqual({
      type: "accepted",
      draft: POLICY.replace(DROP_TRUST.oldText, ""),
      gate: {
        verification: "unverified",
        reasons: ["no_saved_validations"],
        files: [],
        suiteVersion: "empty",
      },
    });
    await expectNothingWritten({ revision: 1, suite: null });
  });

  test("a validation that cannot run leaves the change unverified", async () => {
    await savePolicy(POLICY);
    const suite = await saveSuite([FRESH_SEND, EXTERNAL_SEND]);
    const outcome = await checkPolicyChange({
      organizationId,
      userId,
      expectedRevision: 1,
      edits: [
        {
          oldText: "delta = { trust = 'suspicious' }\n",
          newText: "annotator = 'probe'\n",
        },
        {
          oldText: "[policy]\nversion = 2\n",
          newText:
            "[policy]\nversion = 2\n[[policy.annotator]]\nname = 'probe'\nbuiltin = 'archestra'\nranks = ['suspicious', 'trusted']\nmarks = []\neffects = []\n",
        },
      ],
    });
    // Nothing in the test process answers the archestra annotator's consult.
    expect(outcome).toMatchObject({
      type: "accepted",
      gate: {
        verification: "unverified",
        reasons: ["validation_cannot_run"],
        suiteVersion: suite?.version,
      },
    });
    if (outcome.type !== "accepted") throw new Error("expected acceptance");
    expect(
      Object.fromEntries(
        outcome.gate.files.map((file) => [file.path, file.status]),
      ),
    ).toEqual({
      [FRESH_SEND.path]: "passed",
      [EXTERNAL_SEND.path]: "cannot_run",
    });
    await expectNothingWritten({ revision: 1, suite });
  });

  test("a change every saved validation passes is verified", async () => {
    await savePolicy(POLICY);
    const suite = await saveSuite([FRESH_SEND, EXTERNAL_SEND]);
    const outcome = await checkPolicyChange({
      organizationId,
      userId,
      expectedRevision: 1,
      edits: [ADD_RULE],
    });
    expect(outcome).toMatchObject({
      type: "accepted",
      draft: POLICY.replace(ADD_RULE.oldText, ADD_RULE.newText),
      gate: {
        verification: "verified",
        reasons: [],
        suiteVersion: suite?.version,
      },
    });
    if (outcome.type !== "accepted") throw new Error("expected acceptance");
    expect(outcome.gate.files).toEqual(
      expect.arrayContaining([
        { path: FRESH_SEND.path, status: "passed", error: null },
        { path: EXTERNAL_SEND.path, status: "passed", error: null },
      ]),
    );
    await expectNothingWritten({ revision: 1, suite });
  });

  test("under Git sync the gate checks the synced revision against the repository's suite", async () => {
    const commit = "a".repeat(40);
    await OpenAppaGithubSyncModel.save(organizationId, {
      repo: "example/policy",
      path: "organization.appa.toml",
      ref: "main",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
    });
    const configured = await OpenAppaGithubSyncModel.find(organizationId);
    await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision: configured?.revision ?? "",
      outcome: {
        content: POLICY,
        contentHash: createHash("sha256").update(POLICY).digest("hex"),
        sourceCommit: commit,
      },
    });
    const synced = await OpenAppaGithubSyncModel.find(organizationId);
    await OpenAppaPolicyTestsModel.cacheGithub({
      organizationId,
      files: [FRESH_SEND, EXTERNAL_SEND],
      sourceRevision: synced?.revision ?? "",
      sourceCommit: commit,
      directory: "traces",
    });
    const cached = await OpenAppaPolicyTestsModel.find(organizationId);

    const check = (edits: GuardrailsPolicyEdit[]) =>
      checkPolicyChange({ organizationId, userId, expectedRevision: 1, edits });
    expect(await check([DROP_TRUST])).toMatchObject({
      type: "rejected",
      reason: "validation_failed",
    });
    expect(await check([ADD_RULE])).toMatchObject({
      type: "accepted",
      gate: { verification: "verified", reasons: [] },
    });

    expect(
      (await GuardrailsPolicyModel.findLatest(organizationId))?.revision,
    ).toBe(1);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toEqual(synced);
    expect(await OpenAppaPolicyTestsModel.find(organizationId)).toEqual(cached);
    expect(await OpenAppaPolicyTestsModel.listRuns(organizationId)).toEqual([]);
  });
});

async function savePolicy(content: string) {
  await GuardrailsPolicyModel.save({
    organizationId,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    updatedBy: userId,
    expectedRevision: 0,
  });
}

function saveSuite(files: PolicyTestFile[]) {
  return OpenAppaPolicyTestsModel.saveLocal({
    organizationId,
    files,
    expectedVersion: "empty",
  });
}

function withGithubBattery(): string {
  const archestra = bundledEntry(ARCHESTRA_BATTERY);
  return initialPolicy().replace(
    `"${archestra}",\n`,
    `"${archestra}",\n  "${bundledEntry("github")}",\n`,
  );
}

async function expectNothingWritten(expected: {
  revision: number;
  suite: Awaited<ReturnType<typeof saveSuite>> | null;
}) {
  expect(
    (await GuardrailsPolicyModel.findLatest(organizationId))?.revision,
  ).toBe(expected.revision);
  expect((await OpenAppaPolicyTestsModel.find(organizationId))?.version).toBe(
    expected.suite?.version,
  );
  expect(await OpenAppaPolicyTestsModel.listRuns(organizationId)).toEqual([]);
  expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
}
