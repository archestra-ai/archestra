import { createHash } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaCredentialBindingModel from "@/models/openappa-credential-binding";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { openappaDeclarations } from "@/openappa/declarations";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import { PolicyTestChangesSchema } from "@/types/openappa-validation-change";
import {
  previewOpenAppaValidationChange,
  publishOpenAppaValidationChange,
} from "./openappa-validation-change";

const policy = `[policy]
version = 2
[[policy.tool]]
name = "files__read"
delta = { trust = "suspicious" }
[[policy.tool]]
name = "mail__send"
delta = {}
requires = { trust = "trusted" }
`;
const proposedPolicy = policy.replace(
  'trust = "trusted"',
  'trust = "suspicious"',
);
const existing = {
  path: "traces/keep.appa",
  content:
    "# Reading untrusted material must prevent sending mail.\nmcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny\n",
};
const added = {
  path: "traces/request.appa",
  content:
    "# This proposed rule permits the requested workflow.\nmcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect allow\n",
};
const hash = (content: string) =>
  createHash("sha256").update(content).digest("hex");

describe("source-aware validation proposals", () => {
  const ctx = useRouteTestApp(async () => {});
  let version: string;
  const caller = () => ({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
  });
  const request = () => ({
    ...caller(),
    expectedRevision: 1,
    expectedVersion: version,
    changes: { upsert: [added], delete: [] },
  });
  const publish = () => ({
    ...request(),
    title: "Cover requested behavior",
    summary: "A focused policy and specification proposal",
  });
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    await GuardrailsPolicyModel.save({
      ...caller(),
      content: policy,
      contentHash: hash(policy),
      updatedBy: ctx.user.id,
      expectedRevision: 0,
    });
    const suite = await OpenAppaPolicyTestsModel.saveLocal({
      organizationId: ctx.organizationId,
      files: [existing],
      expectedVersion: "empty",
    });
    if (!suite) throw new Error("Fixture suite not saved");
    version = suite.version;
  });

  test("candidate-policy replay keeps unrelated regressions and changes no active state or saved history", async () => {
    const unsupported = {
      path: "traces/unknown.appa",
      content: "mcp/unknown/tool {}\nexpect allow\n",
    };
    const preview = await previewOpenAppaValidationChange({
      ...request(),
      policyContent: proposedPolicy,
      changes: { upsert: [added, unsupported], delete: [] },
    });
    expect(preview.policy.changed).toBe(true);
    expect(preview.counts).toEqual({ passed: 1, failed: 1, cannotRun: 1 });
    expect(preview.tests.files).toMatchObject([
      { path: existing.path, status: "failed" },
      { path: added.path, status: "passed" },
      { path: unsupported.path, status: "cannot_run" },
    ]);
    expect(preview.tests).toMatchObject({
      draft: true,
      policyHash: hash(proposedPolicy),
    });
    expect(await guardrailsPolicyService.get(ctx.organizationId)).toMatchObject(
      { content: policy, revision: 1 },
    );
    expect(
      await OpenAppaPolicyTestsModel.find(ctx.organizationId),
    ).toMatchObject({ version, files: [existing] });
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(0);
  });

  test("candidate replay applies stored credential bindings without writing them into the policy", async () => {
    await OpenAppaCredentialBindingModel.upsert({
      organizationId: ctx.organizationId,
      variable: "APPA_PROVIDER_GITHUB_TOKEN",
      credentialKey: "stored-github",
      updatedBy: ctx.user.id,
    });
    const candidate = `include = ["batteries/github/appa.toml"]\n\n${policy}`;
    const preview = await previewOpenAppaValidationChange({
      ...request(),
      policyContent: candidate,
      changes: { upsert: [], delete: [] },
    });
    const declared = `${candidate}\n[credentials]\nAPPA_PROVIDER_GITHUB_TOKEN = "stored-github"\n`;
    const composed = await openappaDeclarations.composeForCheck({
      root: declared,
      resolution: await openappaDeclarations.resolve({
        organizationId: ctx.organizationId,
        content: declared,
      }),
    });
    expect(composed.content).toBeTruthy();
    expect(preview.tests.effectivePolicyHash).toBe(
      hash(composed.content ?? ""),
    );
    expect(preview.tests.policyHash).toBe(hash(candidate));
    expect(preview.tests.validation.valid).toBe(true);
    expect(preview.tests.files).toMatchObject([
      {
        path: existing.path,
        status: "cannot_run",
        error: expect.stringMatching(/\S/),
      },
    ]);
    expect(await guardrailsPolicyService.get(ctx.organizationId)).toMatchObject(
      {
        content: policy,
        revision: 1,
      },
    );
  });

  test("policy and specification publication is atomic and failed assertions stay informational", async () => {
    const saved = await publishOpenAppaValidationChange({
      ...publish(),
      policyContent: proposedPolicy,
    });
    expect(saved).toMatchObject({
      delivery: "revision",
      revision: 2,
      policyChanged: true,
      counts: { passed: 1, failed: 1, cannotRun: 0 },
    });
    expect(await guardrailsPolicyService.get(ctx.organizationId)).toMatchObject(
      { content: proposedPolicy, revision: 2 },
    );
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.files,
    ).toEqual([existing, added]);
  });

  test("invalid policy never writes either half of a combined change", async () => {
    await expect(
      publishOpenAppaValidationChange({
        ...publish(),
        policyContent: "[invalid",
      }),
    ).rejects.toThrow();
    expect(await guardrailsPolicyService.get(ctx.organizationId)).toMatchObject(
      { revision: 1, content: policy },
    );
    expect(
      await OpenAppaPolicyTestsModel.find(ctx.organizationId),
    ).toMatchObject({ version, files: [existing] });
  });

  test("an unparseable scenario makes the proposal invalid and publication refuses it", async () => {
    const broken = {
      path: "traces/broken.appa",
      content: "mcp/files/read {}\nexpect maybe\n",
    };
    const changes = { upsert: [broken], delete: [] };
    const preview = await previewOpenAppaValidationChange({
      ...request(),
      changes,
    });
    expect(preview.tests.validation.valid).toBe(false);
    expect(preview.tests.validation.errors).toHaveLength(1);
    await expect(
      publishOpenAppaValidationChange({ ...publish(), changes }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(
      await OpenAppaPolicyTestsModel.find(ctx.organizationId),
    ).toMatchObject({ version, files: [existing] });
  });

  test("stale specification versions fail without a policy revision", async () => {
    await expect(
      publishOpenAppaValidationChange({
        ...publish(),
        policyContent: proposedPolicy,
        expectedVersion: "stale",
      }),
    ).rejects.toThrow("changed");
    expect(await guardrailsPolicyService.get(ctx.organizationId)).toMatchObject(
      { revision: 1 },
    );
    await expect(
      guardrailsPolicyService.update({
        ...caller(),
        content: proposedPolicy,
        expectedRevision: 1,
        validation: { expectedVersion: "stale", files: [added] },
      }),
    ).rejects.toThrow("changed");
    expect(await guardrailsPolicyService.get(ctx.organizationId)).toMatchObject(
      { revision: 1 },
    );
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.files,
    ).toEqual([existing]);
  });

  test("tests-only persistence rejects a changed policy at the transactional boundary", async () => {
    expect(
      await OpenAppaPolicyTestsModel.saveLocal({
        organizationId: ctx.organizationId,
        files: [added],
        expectedVersion: version,
        expectedPolicyRevision: 0,
      }),
    ).toBeNull();
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.files,
    ).toEqual([existing]);
  });

  test("enabling Git prevents atomic local policy/test publication", async () => {
    await OpenAppaGithubSyncModel.save(ctx.organizationId, {
      repo: "example/policies",
      ref: "main",
      path: "appa.toml",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
      validationDirectory: "",
    });
    expect(
      await GuardrailsPolicyModel.save({
        organizationId: ctx.organizationId,
        content: proposedPolicy,
        contentHash: hash(proposedPolicy),
        updatedBy: ctx.user.id,
        expectedRevision: 1,
        validation: {
          expectedVersion:
            (await OpenAppaPolicyTestsModel.find(ctx.organizationId))
              ?.version ?? "empty",
          files: [added],
        },
      }),
    ).toBeNull();
    expect(await guardrailsPolicyService.get(ctx.organizationId)).toMatchObject(
      { revision: 1 },
    );
  });

  test("ambiguous patches and nonexistent deletions are rejected", async () => {
    expect(
      PolicyTestChangesSchema.safeParse({
        upsert: [added],
        delete: [added.path],
      }).success,
    ).toBe(false);
    await expect(
      previewOpenAppaValidationChange({
        ...request(),
        changes: { upsert: [], delete: [added.path] },
      }),
    ).rejects.toThrow("does not exist");
  });

  test("deleting the final validation leaves an empty suite without an execution failure", async () => {
    const saved = await publishOpenAppaValidationChange({
      ...publish(),
      changes: { upsert: [], delete: [existing.path] },
    });
    expect(saved).toMatchObject({
      revision: 1,
      policyChanged: false,
      counts: { passed: 0, failed: 0, cannotRun: 0 },
      tests: { files: [], validation: { valid: true } },
    });
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.files,
    ).toEqual([]);
    expect(await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId)).toEqual(
      [],
    );
  });

  test("a policy-only proposal validates and publishes when no specifications exist", async () => {
    const empty = await OpenAppaPolicyTestsModel.saveLocal({
      organizationId: ctx.organizationId,
      files: [],
      expectedVersion: version,
    });
    const saved = await publishOpenAppaValidationChange({
      ...publish(),
      expectedVersion: empty?.version ?? "empty",
      policyContent: proposedPolicy,
      changes: { upsert: [], delete: [] },
    });
    expect(saved).toMatchObject({
      revision: 2,
      policyChanged: true,
      counts: { passed: 0, failed: 0, cannotRun: 0 },
      tests: { files: [], validation: { valid: true } },
    });
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.version,
    ).toBe(empty?.version);
  });
});
