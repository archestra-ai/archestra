import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { RunArtifact } from "@/knowledge-base/evaluation/schema";
import type {
  InsertRetrievalEvaluationRun,
  KnowledgeEvaluationComponent,
  RetrievalEvaluationRun,
  RetrievalEvaluationRunStage,
  RetrievalEvaluationRunStatus,
} from "@/types";

type ClaimResult =
  | { status: "claimed"; run: RetrievalEvaluationRun }
  | { status: "busy" }
  | { status: "cancelled" }
  | { status: "terminal" }
  | { status: "missing" };

class RetrievalEvaluationRunModel {
  static async create(
    data: InsertRetrievalEvaluationRun,
  ): Promise<RetrievalEvaluationRun> {
    const [run] = await db
      .insert(schema.retrievalEvaluationRunsTable)
      .values(data)
      .returning();
    return run as RetrievalEvaluationRun;
  }

  static async findByIdForOrganization(
    id: string,
    organizationId: string,
  ): Promise<RetrievalEvaluationRun | null> {
    const [run] = await db
      .select()
      .from(schema.retrievalEvaluationRunsTable)
      .where(
        and(
          eq(schema.retrievalEvaluationRunsTable.id, id),
          eq(
            schema.retrievalEvaluationRunsTable.organizationId,
            organizationId,
          ),
        ),
      )
      .limit(1);
    return (run as RetrievalEvaluationRun | undefined) ?? null;
  }

  static async findById(id: string): Promise<RetrievalEvaluationRun | null> {
    const [run] = await db
      .select()
      .from(schema.retrievalEvaluationRunsTable)
      .where(eq(schema.retrievalEvaluationRunsTable.id, id))
      .limit(1);
    return (run as RetrievalEvaluationRun | undefined) ?? null;
  }

  static async listByOrganization(params: {
    organizationId: string;
    limit: number;
  }): Promise<RetrievalEvaluationRun[]> {
    return (await db
      .select()
      .from(schema.retrievalEvaluationRunsTable)
      .where(
        eq(
          schema.retrievalEvaluationRunsTable.organizationId,
          params.organizationId,
        ),
      )
      .orderBy(desc(schema.retrievalEvaluationRunsTable.createdAt))
      .limit(params.limit)) as RetrievalEvaluationRun[];
  }

  static async findActiveByOrganization(
    organizationId: string,
  ): Promise<RetrievalEvaluationRun | null> {
    const [run] = await db
      .select()
      .from(schema.retrievalEvaluationRunsTable)
      .where(
        and(
          eq(
            schema.retrievalEvaluationRunsTable.organizationId,
            organizationId,
          ),
          inArray(schema.retrievalEvaluationRunsTable.status, [
            "queued",
            "running",
            "cancel_requested",
          ]),
        ),
      )
      .limit(1);
    return (run as RetrievalEvaluationRun | undefined) ?? null;
  }

  static async listComponentSnapshots(params: {
    organizationId: string;
    limit: number;
  }): Promise<
    Array<{
      id: string;
      selectedComponents: KnowledgeEvaluationComponent[];
      componentFingerprints: Partial<
        Record<KnowledgeEvaluationComponent, string>
      >;
      completedAt: Date | null;
    }>
  > {
    return db
      .select({
        id: schema.retrievalEvaluationRunsTable.id,
        selectedComponents:
          schema.retrievalEvaluationRunsTable.selectedComponents,
        componentFingerprints:
          schema.retrievalEvaluationRunsTable.componentFingerprints,
        completedAt: schema.retrievalEvaluationRunsTable.completedAt,
      })
      .from(schema.retrievalEvaluationRunsTable)
      .where(
        and(
          eq(
            schema.retrievalEvaluationRunsTable.organizationId,
            params.organizationId,
          ),
          inArray(schema.retrievalEvaluationRunsTable.status, [
            "completed",
            "degraded",
            "blocked",
          ]),
        ),
      )
      .orderBy(desc(schema.retrievalEvaluationRunsTable.completedAt))
      .limit(params.limit);
  }

  static async attachTask(params: {
    id: string;
    taskId: string;
  }): Promise<void> {
    await db
      .update(schema.retrievalEvaluationRunsTable)
      .set({ taskId: params.taskId })
      .where(eq(schema.retrievalEvaluationRunsTable.id, params.id));
  }

  /** Atomically serialize all executions while allowing queued runs to coexist. */
  static async claimForExecution(id: string): Promise<ClaimResult> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('retrieval_evaluation_claim'))`,
      );
      const [run] = await tx
        .select()
        .from(schema.retrievalEvaluationRunsTable)
        .where(eq(schema.retrievalEvaluationRunsTable.id, id))
        .limit(1);
      if (!run) return { status: "missing" };
      if (run.status === "cancel_requested" || run.status === "cancelled") {
        return { status: "cancelled" };
      }
      if (!["queued", "running"].includes(run.status)) {
        return { status: "terminal" };
      }
      const [other] = await tx
        .select({ id: schema.retrievalEvaluationRunsTable.id })
        .from(schema.retrievalEvaluationRunsTable)
        .where(
          and(
            ne(schema.retrievalEvaluationRunsTable.id, id),
            inArray(schema.retrievalEvaluationRunsTable.status, [
              "running",
              "cancel_requested",
            ]),
          ),
        )
        .limit(1);
      if (other) return { status: "busy" };

      const [claimed] = await tx
        .update(schema.retrievalEvaluationRunsTable)
        .set({
          status: "running",
          stage: "preparing",
          startedAt: run.startedAt ?? new Date(),
          completedAt: null,
          error: null,
          progressMessage: "Preparing evaluation",
        })
        .where(eq(schema.retrievalEvaluationRunsTable.id, id))
        .returning();
      return { status: "claimed", run: claimed as RetrievalEvaluationRun };
    });
  }

  static async updateProgress(params: {
    id: string;
    stage: RetrievalEvaluationRunStage;
    current: number;
    total: number;
    message: string;
  }): Promise<void> {
    await db
      .update(schema.retrievalEvaluationRunsTable)
      .set({
        stage: params.stage,
        progressCurrent: params.current,
        progressTotal: params.total,
        progressMessage: params.message,
      })
      .where(
        and(
          eq(schema.retrievalEvaluationRunsTable.id, params.id),
          inArray(schema.retrievalEvaluationRunsTable.status, [
            "running",
            "cancel_requested",
          ]),
        ),
      );
  }

  static async setFixture(params: {
    id: string;
    knowledgeBaseId: string;
    connectorId: string;
  }): Promise<void> {
    await db
      .update(schema.retrievalEvaluationRunsTable)
      .set({
        fixtureKnowledgeBaseId: params.knowledgeBaseId,
        fixtureConnectorId: params.connectorId,
      })
      .where(eq(schema.retrievalEvaluationRunsTable.id, params.id));
  }

  static async markBm25Refreshed(id: string): Promise<void> {
    await db
      .update(schema.retrievalEvaluationRunsTable)
      .set({ bm25Refreshed: true })
      .where(eq(schema.retrievalEvaluationRunsTable.id, id));
  }

  static async setComponentFingerprints(params: {
    id: string;
    fingerprints: Partial<Record<KnowledgeEvaluationComponent, string>>;
  }): Promise<void> {
    await db
      .update(schema.retrievalEvaluationRunsTable)
      .set({ componentFingerprints: params.fingerprints })
      .where(eq(schema.retrievalEvaluationRunsTable.id, params.id));
  }

  static async clearFixture(id: string): Promise<void> {
    await db
      .update(schema.retrievalEvaluationRunsTable)
      .set({
        fixtureKnowledgeBaseId: null,
        fixtureConnectorId: null,
        bm25Refreshed: false,
      })
      .where(eq(schema.retrievalEvaluationRunsTable.id, id));
  }

  static async isCancellationRequested(id: string): Promise<boolean> {
    const [run] = await db
      .select({ status: schema.retrievalEvaluationRunsTable.status })
      .from(schema.retrievalEvaluationRunsTable)
      .where(eq(schema.retrievalEvaluationRunsTable.id, id))
      .limit(1);
    return run?.status === "cancel_requested" || run?.status === "cancelled";
  }

  static async requestCancellation(params: {
    id: string;
    organizationId: string;
  }): Promise<RetrievalEvaluationRun | null> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('retrieval_evaluation_claim'))`,
      );
      const [run] = await tx
        .select()
        .from(schema.retrievalEvaluationRunsTable)
        .where(
          and(
            eq(schema.retrievalEvaluationRunsTable.id, params.id),
            eq(
              schema.retrievalEvaluationRunsTable.organizationId,
              params.organizationId,
            ),
          ),
        )
        .limit(1);
      if (!run) return null;
      if (run.status === "queued") {
        const [cancelled] = await tx
          .update(schema.retrievalEvaluationRunsTable)
          .set({
            status: "cancelled",
            stage: "completed",
            cancellationRequestedAt: new Date(),
            completedAt: new Date(),
            progressMessage: "Cancelled before execution",
          })
          .where(eq(schema.retrievalEvaluationRunsTable.id, params.id))
          .returning();
        return cancelled as RetrievalEvaluationRun;
      }
      if (run.status === "running") {
        const [requested] = await tx
          .update(schema.retrievalEvaluationRunsTable)
          .set({
            status: "cancel_requested",
            cancellationRequestedAt: new Date(),
            progressMessage: "Cancellation requested",
          })
          .where(eq(schema.retrievalEvaluationRunsTable.id, params.id))
          .returning();
        return requested as RetrievalEvaluationRun;
      }
      return run as RetrievalEvaluationRun;
    });
  }

  static async complete(params: {
    id: string;
    artifact: RunArtifact;
  }): Promise<RetrievalEvaluationRun | null> {
    return RetrievalEvaluationRunModel.finish({
      id: params.id,
      status: params.artifact.status,
      artifact: params.artifact,
      error: params.artifact.errors[0] ?? null,
      message: `Evaluation ${params.artifact.status}`,
      clearFixture: true,
    });
  }

  static async markCancelled(
    id: string,
  ): Promise<RetrievalEvaluationRun | null> {
    return RetrievalEvaluationRunModel.finish({
      id,
      status: "cancelled",
      artifact: null,
      error: null,
      message: "Evaluation cancelled",
      clearFixture: true,
    });
  }

  static async markFailed(params: {
    id: string;
    error: string;
  }): Promise<RetrievalEvaluationRun | null> {
    return RetrievalEvaluationRunModel.finish({
      id: params.id,
      status: "failed",
      artifact: null,
      error: params.error,
      message: "Evaluation failed",
      clearFixture: false,
    });
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const run = await RetrievalEvaluationRunModel.findByIdForOrganization(
      id,
      organizationId,
    );
    if (!run) return null;
    return {
      id: run.id,
      organizationId: run.organizationId,
      requestedByUserId: run.requestedByUserId,
      name: run.name,
      status: run.status,
      stage: run.stage,
      progressCurrent: run.progressCurrent,
      progressTotal: run.progressTotal,
      selectedComponents: run.selectedComponents,
      settingsOverrides: run.settingsOverrides,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    };
  }

  // ===== Internal helpers =====

  private static async finish(params: {
    id: string;
    status: RetrievalEvaluationRunStatus;
    artifact: RunArtifact | null;
    error: string | null;
    message: string;
    clearFixture: boolean;
  }): Promise<RetrievalEvaluationRun | null> {
    const [run] = await db
      .update(schema.retrievalEvaluationRunsTable)
      .set({
        status: params.status,
        stage: "completed",
        artifact: params.artifact,
        error: params.error,
        progressMessage: params.message,
        completedAt: new Date(),
        ...(params.clearFixture && {
          fixtureKnowledgeBaseId: null,
          fixtureConnectorId: null,
          bm25Refreshed: false,
        }),
      })
      .where(eq(schema.retrievalEvaluationRunsTable.id, params.id))
      .returning();
    return (run as RetrievalEvaluationRun | undefined) ?? null;
  }
}

export default RetrievalEvaluationRunModel;
