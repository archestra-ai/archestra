import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { githubPolicyTestVersion } from "@/openappa/policy-test-hashes";
import type {
  PolicyTestFile,
  PolicyTestRunResult,
} from "@/types/openappa-policy-tests";
import { lockGuardrailsPolicy } from "./guardrails-policy";

const suites = schema.openappaPolicyTestSuitesTable;
const runs = schema.openappaPolicyTestRunsTable;

class OpenAppaPolicyTestsModel {
  static policyValidationSourceIdentity(
    source: typeof schema.openappaGithubSyncTable.$inferSelect | null,
    directory: string,
  ) {
    return JSON.stringify(
      source?.interval
        ? [
            "github",
            source.repo,
            source.ref,
            source.path,
            true,
            source.githubPatId,
            source.githubAppConfigId,
            directory,
          ]
        : ["local", source?.revision ?? null],
    );
  }
  static async enqueuePolicyValidation(
    organizationId: string,
    expectedPolicyHash: string,
  ) {
    return db.transaction(async (tx) => {
      await lockGuardrailsPolicy(tx, organizationId);
      const [source] = await tx
        .select()
        .from(schema.openappaGithubSyncTable)
        .where(
          eq(schema.openappaGithubSyncTable.organizationId, organizationId),
        );
      const [suite] = await tx
        .select()
        .from(suites)
        .where(eq(suites.organizationId, organizationId));
      const [policy] = await tx
        .select()
        .from(schema.guardrailsPolicyRevisionsTable)
        .where(
          eq(
            schema.guardrailsPolicyRevisionsTable.organizationId,
            organizationId,
          ),
        )
        .orderBy(desc(schema.guardrailsPolicyRevisionsTable.revision))
        .limit(1);
      const directory = source?.interval
        ? (suite?.directory ?? "traces")
        : suite?.directory || "traces";
      if (
        !policy ||
        policy.contentHash !== expectedPolicyHash ||
        (source?.interval ? !source.repo || !directory : !suite?.files.length)
      )
        return;
      const sourceIdentity =
        OpenAppaPolicyTestsModel.policyValidationSourceIdentity(
          source ?? null,
          directory,
        );
      const key = JSON.stringify([
        "policy_change",
        policy.revision,
        policy.contentHash,
        sourceIdentity,
      ]);
      const [completed] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.organizationId, organizationId),
            sql`${runs.result}->>'automaticKey' = ${key}`,
            sql`${runs.result}->>'executionError' IS NULL`,
          ),
        )
        .limit(1);
      const [pending] = await tx
        .select({ id: schema.tasksTable.id })
        .from(schema.tasksTable)
        .where(
          and(
            eq(schema.tasksTable.taskType, "openappa_policy_validation"),
            sql`(${schema.tasksTable.status} IN ('pending', 'processing') OR ${schema.tasksTable.payload}->>'validationCompleted' = 'true')`,
            sql`${schema.tasksTable.payload}->>'organizationId' = ${organizationId}`,
            sql`${schema.tasksTable.payload}->>'key' = ${key}`,
          ),
        )
        .limit(1);
      if (completed || pending) return;
      await tx.insert(schema.tasksTable).values({
        taskType: "openappa_policy_validation",
        payload: {
          organizationId,
          source: source?.interval ? "github" : "local",
          sourceIdentity,
          repo: source?.interval ? source.repo : null,
          directory,
          policyHash: policy.contentHash,
          policyRevision: policy.revision,
          key,
        },
        maxAttempts: 3,
      });
    });
  }
  static async isPolicyValidationCurrent(
    organizationId: string,
    policyHash: string,
    queuedRevision?: number,
  ) {
    const policies = schema.guardrailsPolicyRevisionsTable;
    const revisions = await db
      .select({ contentHash: policies.contentHash })
      .from(policies)
      .where(
        and(
          eq(policies.organizationId, organizationId),
          ...(queuedRevision === undefined
            ? []
            : [sql`${policies.revision} >= ${queuedRevision}`]),
        ),
      )
      .orderBy(desc(policies.revision));
    return Boolean(
      revisions.length &&
        revisions[0].contentHash === policyHash &&
        (queuedRevision === undefined ||
          revisions.every((row) => row.contentHash === policyHash)),
    );
  }
  static async shouldRetryPolicyValidation(job: {
    organizationId: string;
    policyHash: string;
    policyRevision?: number;
    source: "local" | "github";
    sourceIdentity: string;
    repo?: string | null;
    directory: string;
    key: string;
  }) {
    return db.transaction(async (tx) => {
      await lockGuardrailsPolicy(tx, job.organizationId);
      const [source] = await tx
        .select()
        .from(schema.openappaGithubSyncTable)
        .where(
          eq(schema.openappaGithubSyncTable.organizationId, job.organizationId),
        );
      const [suite] = await tx
        .select()
        .from(suites)
        .where(eq(suites.organizationId, job.organizationId));
      const policies = schema.guardrailsPolicyRevisionsTable;
      const revisions = await tx
        .select({ contentHash: policies.contentHash })
        .from(policies)
        .where(
          and(
            eq(policies.organizationId, job.organizationId),
            ...(job.policyRevision === undefined
              ? []
              : [sql`${policies.revision} >= ${job.policyRevision}`]),
          ),
        )
        .orderBy(desc(policies.revision));
      const mode = source?.interval ? "github" : "local";
      const directory = source?.interval
        ? (suite?.directory ?? "traces")
        : suite?.directory || "traces";
      if (
        mode !== job.source ||
        !revisions.length ||
        revisions[0].contentHash !== job.policyHash ||
        (job.policyRevision !== undefined &&
          revisions.some((row) => row.contentHash !== job.policyHash)) ||
        OpenAppaPolicyTestsModel.policyValidationSourceIdentity(
          source ?? null,
          directory,
        ) !== job.sourceIdentity ||
        (mode === "github"
          ? !directory ||
            directory !== job.directory ||
            source?.repo !== job.repo
          : !suite?.files.length)
      )
        return false;
      const [completedTask] = await tx
        .select({ id: schema.tasksTable.id })
        .from(schema.tasksTable)
        .where(
          and(
            eq(schema.tasksTable.taskType, "openappa_policy_validation"),
            sql`${schema.tasksTable.payload}->>'organizationId' = ${job.organizationId}`,
            sql`${schema.tasksTable.payload}->>'key' = ${job.key}`,
            sql`${schema.tasksTable.payload}->>'validationCompleted' = 'true'`,
          ),
        )
        .limit(1);
      const [completedRun] = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.organizationId, job.organizationId),
            sql`${runs.result}->>'automaticKey' = ${job.key}`,
            sql`${runs.result}->>'executionError' IS NULL`,
          ),
        )
        .limit(1);
      return !completedTask && !completedRun;
    });
  }
  static async find(organizationId: string) {
    const [row] = await db
      .select()
      .from(suites)
      .where(eq(suites.organizationId, organizationId));
    return row ?? null;
  }
  static async saveLocal(params: {
    organizationId: string;
    files: PolicyTestFile[];
    expectedVersion: string;
    expectedPolicyRevision?: number;
  }) {
    return db.transaction(async (tx) => {
      await lockGuardrailsPolicy(tx, params.organizationId);
      const [source] = await tx
        .select()
        .from(schema.openappaGithubSyncTable)
        .where(
          eq(
            schema.openappaGithubSyncTable.organizationId,
            params.organizationId,
          ),
        );
      if (source?.interval) return null;
      if (params.expectedPolicyRevision !== undefined) {
        const [policy] = await tx
          .select()
          .from(schema.guardrailsPolicyRevisionsTable)
          .where(
            eq(
              schema.guardrailsPolicyRevisionsTable.organizationId,
              params.organizationId,
            ),
          )
          .orderBy(desc(schema.guardrailsPolicyRevisionsTable.revision))
          .limit(1);
        if ((policy?.revision ?? 0) !== params.expectedPolicyRevision)
          return null;
      }
      const [current] = await tx
        .select()
        .from(suites)
        .where(eq(suites.organizationId, params.organizationId));
      if ((current?.version ?? "empty") !== params.expectedVersion) return null;
      const values = {
        files: params.files,
        version: randomUUID(),
        sourceRevision: null,
        sourceCommit: null,
      };
      const [saved] = await tx
        .insert(suites)
        .values({ organizationId: params.organizationId, ...values })
        .onConflictDoUpdate({ target: suites.organizationId, set: values })
        .returning();
      return saved;
    });
  }
  static async cacheGithub(params: {
    organizationId: string;
    files: PolicyTestFile[];
    sourceRevision: string;
    sourceCommit: string;
    directory: string;
  }) {
    return db.transaction(async (tx) => {
      await lockGuardrailsPolicy(tx, params.organizationId);
      const [source] = await tx
        .select()
        .from(schema.openappaGithubSyncTable)
        .where(
          eq(
            schema.openappaGithubSyncTable.organizationId,
            params.organizationId,
          ),
        );
      if (
        !source?.interval ||
        source.revision !== params.sourceRevision ||
        source.sourceCommit !== params.sourceCommit
      )
        return false;
      const { organizationId, ...values } = params;
      // The stored UUID is for local saves after disconnect; the service derives the Git version from repository, commit, directory and files.
      const [current] = await tx
        .select()
        .from(suites)
        .where(eq(suites.organizationId, organizationId));
      if ((current?.directory ?? "traces") !== params.directory) return false;
      if (
        current?.sourceCommit === values.sourceCommit &&
        current.directory === values.directory &&
        JSON.stringify(current.files) === JSON.stringify(values.files)
      )
        return true;
      await tx
        .insert(suites)
        .values({ organizationId, ...values, version: randomUUID() })
        .onConflictDoUpdate({
          target: suites.organizationId,
          set: { ...values, version: randomUUID() },
        });
      return true;
    });
  }
  static async saveRun(
    organizationId: string,
    createdBy: string | null,
    result: PolicyTestRunResult,
    snapshots: {
      files: PolicyTestFile[];
      rootContent: string;
      effectiveContent: string;
      sourceRepo: string | null;
      directory: string;
    },
    automaticKey?: string,
    automaticSourceIdentity?: string,
  ) {
    return db.transaction(async (tx) => {
      await lockGuardrailsPolicy(tx, organizationId);
      let retryRunId: string | undefined;
      if (automaticKey) {
        const [source] = await tx
          .select()
          .from(schema.openappaGithubSyncTable)
          .where(
            eq(schema.openappaGithubSyncTable.organizationId, organizationId),
          );
        const [suite] = await tx
          .select()
          .from(suites)
          .where(eq(suites.organizationId, organizationId));
        const [policy] = await tx
          .select()
          .from(schema.guardrailsPolicyRevisionsTable)
          .where(
            eq(
              schema.guardrailsPolicyRevisionsTable.organizationId,
              organizationId,
            ),
          )
          .orderBy(desc(schema.guardrailsPolicyRevisionsTable.revision))
          .limit(1);
        const [effective] = await tx
          .select()
          .from(schema.openappaEffectivePoliciesTable)
          .where(
            eq(
              schema.openappaEffectivePoliciesTable.organizationId,
              organizationId,
            ),
          )
          .for("update");
        const [previous] = await tx
          .select({ id: runs.id, result: runs.result })
          .from(runs)
          .where(
            and(
              eq(runs.organizationId, organizationId),
              sql`${runs.result}->>'automaticKey' = ${automaticKey}`,
            ),
          )
          .limit(1);
        const [completedTask] = await tx
          .select({ id: schema.tasksTable.id })
          .from(schema.tasksTable)
          .where(
            and(
              eq(schema.tasksTable.taskType, "openappa_policy_validation"),
              sql`${schema.tasksTable.payload}->>'organizationId' = ${organizationId}`,
              sql`${schema.tasksTable.payload}->>'key' = ${automaticKey}`,
              sql`${schema.tasksTable.payload}->>'validationCompleted' = 'true'`,
            ),
          )
          .limit(1);
        const directory = source?.interval
          ? (suite?.directory ?? "traces")
          : suite?.directory || "traces";
        const github = Boolean(source?.interval);
        const githubVersion =
          github && suite && suite.sourceCommit === source?.sourceCommit
            ? githubPolicyTestVersion({
                repo: source?.repo ?? null,
                commit: source?.sourceCommit ?? null,
                directory,
                files: suite.files,
              })
            : null;
        if (
          completedTask ||
          (previous && !previous.result.executionError) ||
          result.source !== (github ? "github" : "local") ||
          (automaticSourceIdentity !== undefined &&
            automaticSourceIdentity !==
              OpenAppaPolicyTestsModel.policyValidationSourceIdentity(
                source ?? null,
                directory,
              )) ||
          (github &&
            (!directory ||
              source?.repo !== snapshots.sourceRepo ||
              source?.sourceCommit !== result.sourceCommit ||
              directory !== snapshots.directory)) ||
          ((!result.executionError ||
            result.source === "local" ||
            !result.sourceVersion.startsWith("unavailable:")) &&
            (github
              ? githubVersion !== result.sourceVersion
              : (suite?.version ?? "empty") !== result.sourceVersion)) ||
          policy?.contentHash !== result.policyHash ||
          policy?.revision !== result.policyRevision ||
          effective?.rootRevision !== policy?.revision ||
          effective?.contentHash !== result.effectivePolicyHash
        )
          return null;
        retryRunId = previous?.id;
      }
      const values = {
        organizationId,
        createdBy,
        result: {
          ...result,
          snapshots,
          ...(automaticKey ? { automaticKey } : {}),
        },
      };
      const [saved] = retryRunId
        ? await tx
            .update(runs)
            .set({ ...values, createdAt: new Date() })
            .where(eq(runs.id, retryRunId))
            .returning()
        : await tx.insert(runs).values(values).returning();
      if (automaticKey && !result.executionError)
        await tx
          .update(schema.tasksTable)
          .set({
            payload: sql`${schema.tasksTable.payload} || '{"validationCompleted":true}'::jsonb`,
          })
          .where(
            and(
              eq(schema.tasksTable.taskType, "openappa_policy_validation"),
              sql`${schema.tasksTable.payload}->>'organizationId' = ${organizationId}`,
              sql`${schema.tasksTable.payload}->>'key' = ${automaticKey}`,
            ),
          );
      const expired = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.organizationId, organizationId))
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .offset(20);
      if (expired.length)
        await tx.delete(runs).where(
          and(
            eq(runs.organizationId, organizationId),
            inArray(
              runs.id,
              expired.map((row) => row.id),
            ),
          ),
        );
      return saved;
    });
  }
  static async listRuns(organizationId: string) {
    return db
      .select()
      .from(runs)
      .where(eq(runs.organizationId, organizationId))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(20);
  }
}
export default OpenAppaPolicyTestsModel;
