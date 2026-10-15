import { createHash } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
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

  test("a validation-only preview replays just the changed files against the saved policy", async () => {
    const preview = await previewOpenAppaValidationChange(request());
    // The saved policy still requires trust to send mail, so the draft fails.
    expect(preview.tests).toEqual([
      expect.objectContaining({ path: added.path, status: "failed" }),
    ]);
    expect(
      await OpenAppaPolicyTestsModel.find(ctx.organizationId),
    ).toMatchObject({ version, files: [existing] });
    expect(
      await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId),
    ).toHaveLength(0);
  });

  test("a preview that only deletes replays nothing", async () => {
    const preview = await previewOpenAppaValidationChange({
      ...request(),
      changes: { upsert: [], delete: [existing.path] },
    });
    expect(preview.tests).toBeNull();
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
    expect(preview.validation.valid).toBe(false);
    expect(preview.validation.errors).toEqual([
      expect.stringContaining(broken.path),
    ]);
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
      validation: { valid: true },
    });
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.files,
    ).toEqual([]);
    expect(await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId)).toEqual(
      [],
    );
  });
});
