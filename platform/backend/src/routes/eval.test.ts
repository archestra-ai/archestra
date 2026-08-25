import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  EvalCaseModel,
  EvalRunModel,
  EvalRunResultModel,
  EvalSuiteModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AuditEventName, User } from "@/types";

vi.mock("@/observability");

const enqueueMock = vi.hoisted(() => vi.fn());
vi.mock("@/task-queue", () => ({
  taskQueueService: { enqueue: enqueueMock },
}));

const SAMPLE_ASSERTIONS = [
  {
    type: "contains" as const,
    values: ["ok"],
    mode: "all" as const,
    caseSensitive: false,
  },
];

describe("eval routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    enqueueMock.mockReset().mockResolvedValue({ id: "task-1" });
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organizationId;
    });
    registerAuditLogHook(app);

    const { default: evalRoutes } = await import("./eval");
    await app.register(evalRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const selectAuditRows = (resourceId: string) =>
    db
      .select({
        action: schema.auditLogsTable.action,
        resourceType: schema.auditLogsTable.resourceType,
        resourceId: schema.auditLogsTable.resourceId,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, resourceId));

  /** Audit rows are written fire-and-forget, so poll rather than assert once. */
  const auditRowsFor = async (resourceId: string, action: AuditEventName) => {
    await vi.waitFor(async () => {
      const rows = await selectAuditRows(resourceId);
      expect(rows.some((row) => row.action === action)).toBe(true);
    });
    return (await selectAuditRows(resourceId)).filter(
      (row) => row.action === action,
    );
  };

  async function createSuite(name = "Suite") {
    const response = await app.inject({
      method: "POST",
      url: "/api/eval-suites",
      payload: { name, description: "d" },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function addCase(suiteId: string, overrides = {}) {
    const response = await app.inject({
      method: "POST",
      url: `/api/eval-suites/${suiteId}/cases`,
      payload: {
        name: "case one",
        input: "say ok",
        assertions: SAMPLE_ASSERTIONS,
        ...overrides,
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  test("suite CRUD with audit records", async () => {
    const suite = await createSuite("CRUD suite");
    expect(suite.organizationId).toBe(organizationId);
    expect(suite.createdBy).toBe(user.id);
    const created = await auditRowsFor(suite.id, "evalSuite.created");
    expect(created[0].resourceType).toBe("evalSuite");

    // Duplicate name → 409
    const dup = await app.inject({
      method: "POST",
      url: "/api/eval-suites",
      payload: { name: "CRUD suite" },
    });
    expect(dup.statusCode).toBe(409);

    // Update
    const updated = await app.inject({
      method: "PUT",
      url: `/api/eval-suites/${suite.id}`,
      payload: { name: "Renamed suite" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe("Renamed suite");
    const updatedAudit = await auditRowsFor(suite.id, "evalSuite.updated");
    expect(updatedAudit[0].before).toMatchObject({ name: "CRUD suite" });
    expect(updatedAudit[0].after).toMatchObject({ name: "Renamed suite" });

    // List includes caseCount
    const list = await app.inject({ method: "GET", url: "/api/eval-suites" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0]).toMatchObject({
      id: suite.id,
      caseCount: 0,
    });

    // Delete
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/eval-suites/${suite.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    await auditRowsFor(suite.id, "evalSuite.deleted");
    expect(
      (await app.inject({ method: "GET", url: `/api/eval-suites/${suite.id}` }))
        .statusCode,
    ).toBe(404);
  });

  test("case CRUD audits onto the parent suite with case-list snapshots", async () => {
    const suite = await createSuite("Case suite");
    const evalCase = await addCase(suite.id);
    expect(evalCase.position).toBe(1);

    // Case creation → evalSuite.updated on the suite id (path param).
    await vi.waitFor(async () => {
      const rows = await selectAuditRows(suite.id);
      expect(rows.some((row) => row.action === "evalSuite.updated")).toBe(true);
    });

    // Update the case: audit resource is the suite, after carries the case list.
    const updated = await app.inject({
      method: "PUT",
      url: `/api/eval-cases/${evalCase.id}`,
      payload: { name: "renamed case" },
    });
    expect(updated.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const rows = await selectAuditRows(suite.id);
      const updates = rows.filter((r) => r.action === "evalSuite.updated");
      expect(
        updates.some((row) =>
          JSON.stringify(row.after ?? "").includes("renamed case"),
        ),
      ).toBe(true);
    });

    // Delete the case: after-snapshot shows the suite without the case.
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/eval-cases/${evalCase.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const rows = await selectAuditRows(suite.id);
      const updates = rows.filter((r) => r.action === "evalSuite.updated");
      expect(
        updates.some(
          (row) =>
            JSON.stringify(row.before ?? "").includes("renamed case") &&
            !JSON.stringify(row.after ?? "").includes("renamed case"),
        ),
      ).toBe(true);
    });

    // Invalid assertion payloads are rejected at the schema layer.
    const badRegex = await app.inject({
      method: "POST",
      url: `/api/eval-suites/${suite.id}/cases`,
      payload: {
        name: "bad",
        input: "x",
        assertions: [{ type: "regex", pattern: "([unclosed" }],
      },
    });
    expect(badRegex.statusCode).toBe(400);
    const emptyAssertions = await app.inject({
      method: "POST",
      url: `/api/eval-suites/${suite.id}/cases`,
      payload: { name: "bad", input: "x", assertions: [] },
    });
    expect(emptyAssertions.statusCode).toBe(400);
  });

  test("cross-org isolation on suites, cases, runs", async ({
    makeOrganization,
  }) => {
    const suite = await createSuite("Mine");
    const evalCase = await addCase(suite.id);
    const foreignOrg = await makeOrganization();
    const foreignSuite = await EvalSuiteModel.create({
      organizationId: foreignOrg.id,
      name: "Theirs",
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/eval-suites/${foreignSuite.id}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/eval-suites/${foreignSuite.id}`,
        })
      ).statusCode,
    ).toBe(404);

    const list = await app.inject({ method: "GET", url: "/api/eval-suites" });
    expect(list.json().data.map((s: { id: string }) => s.id)).toEqual([
      suite.id,
    ]);
    expect(evalCase.suiteId).toBe(suite.id);
  });

  test("run creation snapshots cases, enqueues, audits the new run", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({ organizationId });
    const suite = await createSuite("Run suite");
    await addCase(suite.id);
    await addCase(suite.id, { name: "case two", input: "say ok again" });

    const response = await app.inject({
      method: "POST",
      url: `/api/eval-suites/${suite.id}/runs`,
      payload: { agentId: agent.id, name: "ci-build-42" },
    });
    expect(response.statusCode).toBe(200);
    const run = response.json();
    expect(run.status).toBe("pending");
    expect(run.totalCases).toBe(2);
    expect(run.agentNameSnapshot).toBe(agent.name);
    expect(run.name).toBe("ci-build-42");
    expect(enqueueMock).toHaveBeenCalledWith({
      taskType: "eval_run_execute",
      payload: { runId: run.id },
    });

    const results = await EvalRunResultModel.listAllByRun(run.id);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "pending")).toBe(true);

    const audit = await auditRowsFor(run.id, "evalRun.created");
    expect(audit[0].resourceType).toBe("evalRun");
    expect(audit[0].after).toMatchObject({
      id: run.id,
      suiteName: "Run suite",
      totalCases: 2,
    });
  });

  test("run creation guards: empty suite, missing agent, wrong agent type", async ({
    makeInternalAgent,
    makeAgent,
  }) => {
    const suite = await createSuite("Guard suite");
    const agent = await makeInternalAgent({ organizationId });

    // No cases yet
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/eval-suites/${suite.id}/runs`,
          payload: { agentId: agent.id },
        })
      ).statusCode,
    ).toBe(422);

    await addCase(suite.id);

    // Unknown agent
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/eval-suites/${suite.id}/runs`,
          payload: { agentId: crypto.randomUUID() },
        })
      ).statusCode,
    ).toBe(404);

    // Non-internal agent type
    const gateway = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/eval-suites/${suite.id}/runs`,
          payload: { agentId: gateway.id },
        })
      ).statusCode,
    ).toBe(422);
  });

  test("enqueue failure compensates by failing the run", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({ organizationId });
    const suite = await createSuite("Enqueue suite");
    await addCase(suite.id);
    enqueueMock.mockRejectedValue(new Error("queue down"));

    const response = await app.inject({
      method: "POST",
      url: `/api/eval-suites/${suite.id}/runs`,
      payload: { agentId: agent.id },
    });
    expect(response.statusCode).toBe(500);

    const runs = await EvalRunModel.listByOrganization({
      organizationId,
      limit: 10,
      offset: 0,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].error).toContain("enqueue");
    expect(runs[0].canceledCases).toBe(1);
    const results = await EvalRunResultModel.listAllByRun(runs[0].id);
    expect(results[0].status).toBe("canceled");
  });

  test("run listing filters, detail aggregates and results pagination", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({ organizationId });
    const suite = await createSuite("List suite");
    await addCase(suite.id);
    const createResponse = await app.inject({
      method: "POST",
      url: `/api/eval-suites/${suite.id}/runs`,
      payload: { agentId: agent.id },
    });
    const run = createResponse.json();

    const bySuite = await app.inject({
      method: "GET",
      url: `/api/eval-runs?suiteId=${suite.id}`,
    });
    expect(bySuite.json().data.map((r: { id: string }) => r.id)).toEqual([
      run.id,
    ]);
    const byStatus = await app.inject({
      method: "GET",
      url: "/api/eval-runs?status=completed",
    });
    expect(byStatus.json().data).toHaveLength(0);

    const detail = await app.inject({
      method: "GET",
      url: `/api/eval-runs/${run.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: run.id,
      billedCost: 0,
      subscriptionCost: 0,
      totalTokens: 0,
    });

    const results = await app.inject({
      method: "GET",
      url: `/api/eval-runs/${run.id}/results?limit=10&offset=0`,
    });
    expect(results.statusCode).toBe(200);
    expect(results.json().data).toHaveLength(1);
    expect(results.json().pagination.total).toBe(1);
  });

  test("cancel closes pending cases, audits, and rejects terminal runs", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({ organizationId });
    const suite = await createSuite("Cancel suite");
    await addCase(suite.id);
    const run = (
      await app.inject({
        method: "POST",
        url: `/api/eval-suites/${suite.id}/runs`,
        payload: { agentId: agent.id },
      })
    ).json();

    const cancel = await app.inject({
      method: "POST",
      url: `/api/eval-runs/${run.id}/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("canceled");
    expect(cancel.json().canceledCases).toBe(1);

    const results = await EvalRunResultModel.listAllByRun(run.id);
    expect(results[0].status).toBe("canceled");
    await auditRowsFor(run.id, "evalRun.canceled");

    // Cancel again → 409
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/eval-runs/${run.id}/cancel`,
        })
      ).statusCode,
    ).toBe(409);
  });

  test("case cap surfaces as 422", async () => {
    const suite = await createSuite("Capped");
    const { MAX_CASES_PER_SUITE } = await import("@/models/eval-case");
    await db.insert(schema.evalCasesTable).values(
      Array.from({ length: MAX_CASES_PER_SUITE }, (_, i) => ({
        suiteId: suite.id,
        name: `seed ${i}`,
        input: "x",
        assertions: SAMPLE_ASSERTIONS,
        position: i + 1,
      })),
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/eval-suites/${suite.id}/cases`,
      payload: {
        name: "one too many",
        input: "x",
        assertions: SAMPLE_ASSERTIONS,
      },
    });
    expect(response.statusCode).toBe(422);
  });
});
