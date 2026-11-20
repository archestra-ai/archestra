import { createHash } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test, vi } from "@/test";
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

  test("a local save runs only the upserted files and records their failed steps", async () => {
    const saved = await publishOpenAppaValidationChange(publish());
    const savedVersion = (
      await OpenAppaPolicyTestsModel.find(ctx.organizationId)
    )?.version;
    expect(saved).toMatchObject({
      delivery: "revision",
      version: savedVersion,
      run: {
        sourceVersion: savedVersion,
        partial: true,
        draft: false,
        files: [
          {
            path: added.path,
            status: "failed",
            steps: [{ status: "passed" }, { status: "failed", actual: "deny" }],
          },
        ],
      },
    });
    const runs = await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId);
    expect(runs).toHaveLength(1);
    expect(runs[0].result).toMatchObject({
      sourceVersion: savedVersion,
      partial: true,
      files: [{ path: added.path, status: "failed" }],
    });
    expect(await guardrailsPolicyService.get(ctx.organizationId)).toMatchObject(
      { revision: 1, content: policy },
    );
  });

  test("a local save runs the whole resulting suite when every saved file was upserted", async () => {
    const empty = {
      path: "traces/empty.appa",
      content: "# This file has no assertions to replay.\n",
    };
    const saved = await publishOpenAppaValidationChange({
      ...publish(),
      changes: { upsert: [empty], delete: [existing.path] },
    });
    expect(saved).toMatchObject({
      delivery: "revision",
      run: {
        draft: false,
        files: [
          {
            path: empty.path,
            assertionCount: 0,
            status: "cannot_run",
            steps: [],
          },
        ],
      },
    });
    expect(saved).not.toHaveProperty("run.partial");
    const runs = await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId);
    expect(runs).toHaveLength(1);
    expect(runs[0].result).toMatchObject({
      files: [{ path: empty.path, status: "cannot_run" }],
    });
    expect(runs[0].result.partial).toBeUndefined();
  });

  test("a conflict after the local save preserves the files and returns no run", async () => {
    const validate = guardrailsPolicyService.validate.bind(
      guardrailsPolicyService,
    );
    vi.spyOn(guardrailsPolicyService, "validate").mockImplementationOnce(
      async (...args) => {
        await GuardrailsPolicyModel.save({
          ...caller(),
          content: proposedPolicy,
          contentHash: hash(proposedPolicy),
          updatedBy: ctx.user.id,
          expectedRevision: 1,
        });
        return validate(...args);
      },
    );
    const saved = await publishOpenAppaValidationChange(publish());
    expect(saved).toMatchObject({
      delivery: "revision",
      run: null,
      runError: expect.stringContaining("policy changed"),
      savedPaths: [added.path],
    });
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.files,
    ).toEqual([existing, added]);
    expect(await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId)).toEqual(
      [],
    );
    expect(await guardrailsPolicyService.get(ctx.organizationId)).toMatchObject(
      { revision: 2, content: proposedPolicy },
    );
  });

  test.each([
    {
      name: "replay_busy",
      error: Object.assign(new Error("4 concurrent replays active"), {
        code: "replay_busy",
      }),
      expectedMessage: "Too many Guardrails policy tests are running",
    },
    {
      name: "replay_timed_out",
      error: Object.assign(new Error("replay exceeded 30s limit"), {
        code: "replay_timed_out",
      }),
      expectedMessage: "ran longer than its time limit",
    },
  ])("a post-save $name failure preserves the saved files and reports runError without fabricating a run", async ({
    error,
    expectedMessage,
  }) => {
    const native = await import("@archestra/openappa-rs");
    const spy = vi
      .spyOn(native, "replayOpenappaPolicy")
      .mockRejectedValueOnce(error);
    try {
      const saved = await publishOpenAppaValidationChange(publish());
      const savedVersion = (
        await OpenAppaPolicyTestsModel.find(ctx.organizationId)
      )?.version;
      expect(saved).toMatchObject({
        delivery: "revision",
        revision: 1,
        version: savedVersion,
        run: null,
        runError: expect.stringContaining(expectedMessage),
        savedPaths: [added.path],
      });
    } finally {
      spy.mockRestore();
    }
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.files,
    ).toEqual([existing, added]);
    expect(await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId)).toEqual(
      [],
    );
  });

  test("an unexpected post-save run failure preserves the saved files without leaking raw error details", async () => {
    const spy = vi
      .spyOn(OpenAppaPolicyTestsModel, "saveRun")
      .mockRejectedValueOnce(
        new Error("postgres://user:secret@db.internal/appa connection dropped"),
      );
    try {
      const saved = await publishOpenAppaValidationChange(publish());
      expect(saved).toMatchObject({
        delivery: "revision",
        revision: 1,
        run: null,
        savedPaths: [added.path],
      });
      expect("runError" in saved ? saved.runError : undefined).toEqual(
        expect.stringContaining("Guardrails failed unexpectedly"),
      );
      expect("runError" in saved ? saved.runError : "").not.toContain("secret");
      expect("runError" in saved ? saved.runError : "").not.toContain(
        "postgres://",
      );
    } finally {
      spy.mockRestore();
    }
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.files,
    ).toEqual([existing, added]);
    expect(await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId)).toEqual(
      [],
    );
  });

  test("deleting the final validation leaves an empty suite without an execution failure", async () => {
    const saved = await publishOpenAppaValidationChange({
      ...publish(),
      changes: { upsert: [], delete: [existing.path] },
    });
    expect(saved).toMatchObject({
      revision: 1,
      validation: { valid: true },
      run: null,
    });
    expect(saved).not.toHaveProperty("runError");
    expect(saved).not.toHaveProperty("savedPaths");
    expect(
      (await OpenAppaPolicyTestsModel.find(ctx.organizationId))?.files,
    ).toEqual([]);
    expect(await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId)).toEqual(
      [],
    );
  });
});
