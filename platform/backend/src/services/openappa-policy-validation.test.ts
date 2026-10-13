import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { z } from "zod";
import config from "@/config";
import db, { schema } from "@/database";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  PolicyTestFilesSchema,
  PolicyTestRunResultSchema,
} from "@/types/openappa-policy-tests";
import { runAutomaticOpenAppaPolicyTests } from "./openappa-policy-tests";

const policy = `[policy]
version = 2
[[policy.tool]]
name = "mail__send"
delta = {}
requires = { trust = "trusted" }
`;
const files = [
  { path: "traces/allow.appa", content: "mcp/mail/send {}\nexpect allow\n" },
  { path: "traces/fail.appa", content: "mcp/mail/send {}\nexpect deny\n" },
  {
    path: "traces/unknown.appa",
    content: "mcp/missing/call {}\nexpect allow\n",
  },
];
const snapshotsSchema = z.object({
  files: PolicyTestFilesSchema,
  rootContent: z.string(),
  effectiveContent: z.string(),
  sourceRepo: z.string().nullable(),
  directory: z.string(),
});
const hash = (content: string) =>
  createHash("sha256").update(content).digest("hex");

describe("automatic validation of local policy changes", () => {
  const server = useMswServer();
  let organizationId: string;
  let userId: string;
  const savePolicy = (content: string, revision: number) =>
    GuardrailsPolicyModel.save({
      organizationId,
      updatedBy: userId,
      content,
      contentHash: hash(content),
      expectedRevision: revision,
    });
  const jobs = () =>
    db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "openappa_policy_validation"));
  beforeEach(async ({ makeOrganization, makeUser }) => {
    config.openappa.enabled = true;
    organizationId = (await makeOrganization()).id;
    userId = (await makeUser()).id;
    await savePolicy(policy, 0);
    await OpenAppaPolicyTestsModel.saveLocal({
      organizationId,
      files,
      expectedVersion: "empty",
    });
  });

  test("local policy jobs replay all saved specs and retain failures without altering active policy", async () => {
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    const [job] = await jobs();
    await runAutomaticOpenAppaPolicyTests(job.payload);
    const [run] = await OpenAppaPolicyTestsModel.listRuns(organizationId);
    expect(run.createdBy).toBeNull();
    expect(run.result).toMatchObject({
      trigger: "policy_change",
      source: "local",
      sourceCommit: null,
      policyRevision: 1,
      policyHash: hash(policy),
      draft: false,
      files: [
        { status: "passed" },
        { status: "failed" },
        { status: "cannot_run" },
      ],
    });
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({
      content: policy,
      revision: 1,
    });
    expect((await jobs())[0].payload.validationCompleted).toBe(true);
  });

  test("a superseded policy cannot replay even if a later edit restores its old hash", async () => {
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    const [first] = await jobs();
    const changed = `${policy}\n# A new policy revision\n`;
    await savePolicy(changed, 1);
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(changed),
    );
    await savePolicy(policy, 2);
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    await runAutomaticOpenAppaPolicyTests(first.payload);
    expect(
      await OpenAppaPolicyTestsModel.listRuns(organizationId),
    ).toHaveLength(0);
    const current = (await jobs()).find(
      (job) => job.payload.policyRevision === 3,
    );
    expect(current).toBeDefined();
    await runAutomaticOpenAppaPolicyTests(current?.payload ?? {});
    expect(
      (await OpenAppaPolicyTestsModel.listRuns(organizationId))[0].result
        .policyRevision,
    ).toBe(3);
  });

  test("switching to Git authority cancels a queued local run without fallback", async () => {
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    await OpenAppaGithubSyncModel.save(organizationId, {
      repo: "example/policies",
      ref: "main",
      path: "appa.toml",
      interval: "15m",
      githubPatId: null,
      githubAppConfigId: null,
      validationDirectory: "traces",
    });
    await runAutomaticOpenAppaPolicyTests((await jobs())[0].payload);
    expect(
      await OpenAppaPolicyTestsModel.listRuns(organizationId),
    ).toHaveLength(0);
  });

  test("empty local suites and a stale requested policy hash queue no automatic work", async () => {
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      "old-hash",
    );
    const suite = await OpenAppaPolicyTestsModel.find(organizationId);
    await OpenAppaPolicyTestsModel.saveLocal({
      organizationId,
      expectedVersion: suite?.version ?? "",
      files: [],
    });
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    expect(await jobs()).toHaveLength(0);
  });

  test("concurrent local delivery persists one run and durable completion survives history retention", async () => {
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    const [job] = await jobs();
    await Promise.all([
      runAutomaticOpenAppaPolicyTests(job.payload),
      runAutomaticOpenAppaPolicyTests(job.payload),
    ]);
    const [automatic] = await OpenAppaPolicyTestsModel.listRuns(organizationId);
    expect(
      await OpenAppaPolicyTestsModel.listRuns(organizationId),
    ).toHaveLength(1);
    for (let index = 0; index < 20; index++) {
      await OpenAppaPolicyTestsModel.saveRun(
        organizationId,
        userId,
        PolicyTestRunResultSchema.parse(automatic.result),
        snapshotsSchema.parse(automatic.result.snapshots),
      );
    }
    expect(
      await OpenAppaPolicyTestsModel.listRuns(organizationId),
    ).toHaveLength(20);
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    await runAutomaticOpenAppaPolicyTests(job.payload);
    expect(await jobs()).toHaveLength(1);
    expect(
      await OpenAppaPolicyTestsModel.listRuns(organizationId),
    ).toHaveLength(20);
  });

  test("automatic result persistence rejects specs edited while the replay result is in flight", async () => {
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    const [job] = await jobs();
    await runAutomaticOpenAppaPolicyTests(job.payload);
    const [run] = await OpenAppaPolicyTestsModel.listRuns(organizationId);
    const suite = await OpenAppaPolicyTestsModel.find(organizationId);
    await OpenAppaPolicyTestsModel.saveLocal({
      organizationId,
      files: [files[0]],
      expectedVersion: suite?.version ?? "",
    });
    const saved = await OpenAppaPolicyTestsModel.saveRun(
      organizationId,
      null,
      PolicyTestRunResultSchema.parse(run.result),
      snapshotsSchema.parse(run.result.snapshots),
      "another-delivery-of-old-inputs",
      job.payload.sourceIdentity as string,
    );
    expect(saved).toBeNull();
    expect(
      await OpenAppaPolicyTestsModel.saveRun(
        organizationId,
        null,
        {
          ...PolicyTestRunResultSchema.parse(run.result),
          executionError: "Offline replay failed",
        },
        snapshotsSchema.parse(run.result.snapshots),
        "failed-delivery-of-old-inputs",
        job.payload.sourceIdentity as string,
      ),
    ).toBeNull();
    expect(
      await OpenAppaPolicyTestsModel.listRuns(organizationId),
    ).toHaveLength(1);
  });
  test("an identical save during preparation retries and then records the actual policy revision", async () => {
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    const [job] = await jobs();
    const native = await import("@archestra/openappa-rs");
    const compose = native.composeOpenappaPolicy;
    let calls = 0;
    let changed = false;
    const boundary = vi
      .spyOn(native, "composeOpenappaPolicy")
      .mockImplementation(async (input) => {
        const result = await compose(input);
        if (++calls === 2) {
          await savePolicy(policy, 1);
          changed = true;
        }
        return result;
      });
    await expect(runAutomaticOpenAppaPolicyTests(job.payload)).rejects.toThrow(
      "inputs changed; retry",
    );
    expect(changed).toBe(true);
    expect(
      await OpenAppaPolicyTestsModel.listRuns(organizationId),
    ).toHaveLength(0);
    boundary.mockRestore();
    await runAutomaticOpenAppaPolicyTests(job.payload);
    expect(
      (await OpenAppaPolicyTestsModel.listRuns(organizationId))[0].result,
    ).toMatchObject({
      policyRevision: 2,
      policyHash: hash(policy),
    });
    expect((await jobs())[0].payload.validationCompleted).toBe(true);
  });

  test("local spec edits during replay retry and recover using the latest saved suite", async () => {
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    const [job] = await jobs();
    const native = await import("@archestra/openappa-rs");
    const replay = native.replayOpenappaPolicy;
    let version = "";
    const boundary = vi
      .spyOn(native, "replayOpenappaPolicy")
      .mockImplementationOnce(async (input) => {
        const result = await replay(input);
        const suite = await OpenAppaPolicyTestsModel.find(organizationId);
        const saved = await OpenAppaPolicyTestsModel.saveLocal({
          organizationId,
          files: [files[0]],
          expectedVersion: suite?.version ?? "",
        });
        version = saved?.version ?? "";
        return result;
      });
    await expect(runAutomaticOpenAppaPolicyTests(job.payload)).rejects.toThrow(
      "inputs changed; retry",
    );
    expect(
      await OpenAppaPolicyTestsModel.listRuns(organizationId),
    ).toHaveLength(0);
    boundary.mockRestore();
    await runAutomaticOpenAppaPolicyTests(job.payload);
    const [run] = await OpenAppaPolicyTestsModel.listRuns(organizationId);
    expect(run.result.sourceVersion).toBe(version);
    expect(run.result.files).toMatchObject([
      { path: files[0].path, status: "passed" },
    ]);
    expect((await jobs())[0].payload.validationCompleted).toBe(true);
  });

  test("a tests-only Git commit accepted during replay retries against the latest authoritative commit", async () => {
    let currentFiles = files;
    const commit = "a".repeat(40);
    const nextCommit = "b".repeat(40);
    await OpenAppaGithubSyncModel.save(organizationId, {
      repo: "example/policies",
      ref: "main",
      path: "appa.toml",
      interval: "15m",
      githubPatId: null,
      githubAppConfigId: null,
      validationDirectory: "traces",
    });
    const source = await OpenAppaGithubSyncModel.find(organizationId);
    expect(
      await OpenAppaGithubSyncModel.finish({
        organizationId,
        revision: source?.revision ?? "",
        outcome: {
          content: policy,
          contentHash: hash(policy),
          sourceCommit: commit,
        },
      }),
    ).toBe(true);
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/traces",
        ({ request }) => {
          expect([commit, nextCommit]).toContain(
            new URL(request.url).searchParams.get("ref"),
          );
          return HttpResponse.json(
            currentFiles.map((file) => ({
              type: "file",
              path: file.path,
              size: file.content.length,
            })),
          );
        },
      ),
      http.get(
        "https://api.github.com/repos/example/policies/contents/traces/:file",
        ({ params }) =>
          HttpResponse.text(
            currentFiles.find((file) => file.path === `traces/${params.file}`)
              ?.content ?? "",
          ),
      ),
    );
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      hash(policy),
    );
    const [job] = await jobs();
    const native = await import("@archestra/openappa-rs");
    const replay = native.replayOpenappaPolicy;
    const boundary = vi
      .spyOn(native, "replayOpenappaPolicy")
      .mockImplementationOnce(async (input) => {
        const result = await replay(input);
        currentFiles = [files[0]];
        const currentSource =
          await OpenAppaGithubSyncModel.find(organizationId);
        expect(
          await OpenAppaGithubSyncModel.finish({
            organizationId,
            revision: currentSource?.revision ?? "",
            outcome: {
              content: policy,
              contentHash: hash(policy),
              sourceCommit: nextCommit,
            },
          }),
        ).toBe(true);
        return result;
      });
    await expect(runAutomaticOpenAppaPolicyTests(job.payload)).rejects.toThrow(
      "inputs changed; retry",
    );
    expect(
      await OpenAppaPolicyTestsModel.listRuns(organizationId),
    ).toHaveLength(0);
    boundary.mockRestore();
    await runAutomaticOpenAppaPolicyTests(job.payload);
    const [run] = await OpenAppaPolicyTestsModel.listRuns(organizationId);
    expect(run.result).toMatchObject({
      source: "github",
      sourceCommit: nextCommit,
      policyRevision: 1,
      files: [{ path: files[0].path, status: "passed" }],
    });
    expect((await jobs())[0].payload.validationCompleted).toBe(true);
    expect(await jobs()).toHaveLength(1);
  });
});
