import config from "@/config";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("retrieval evaluation routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  let originalEvaluationEnabled: boolean;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    originalEvaluationEnabled = config.kb.evaluationEnabled;
    config.kb.evaluationEnabled = true;
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    registerAuditLogHook(app);
    const { default: routes } = await import("./retrieval-evaluation");
    await app.register(routes);
  });

  afterEach(async () => {
    config.kb.evaluationEnabled = originalEvaluationEnabled;
    await app.close();
  });

  test("reports fixed scenarios and why disabled stages do not apply", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/organization/knowledge-settings/retrieval-evaluations/capabilities",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.totalQueries).toBeGreaterThanOrEqual(10);
    expect(body.capabilities["text-embedding"]).toMatchObject({
      status: "disabled",
    });
    expect(body.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "keyword-ranking",
          mode: "offline",
          selectedByDefault: true,
        }),
        expect.objectContaining({
          id: "text-embedding",
          mode: "online",
          selectedByDefault: false,
        }),
      ]),
    );
    expect(body.scenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "multimodal-image", applicable: false }),
        expect.objectContaining({ id: "ocr-document", applicable: false }),
        expect.objectContaining({
          id: "cross-encoder-procedure",
          applicable: false,
        }),
      ]),
    );
  });

  test("previews capabilities with temporary settings", async () => {
    const saved = await app.inject({
      method: "GET",
      url: "/api/organization/knowledge-settings/retrieval-evaluations/capabilities",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations/capabilities/preview",
      payload: { bm25K1: 0.6, bm25B: 0.35 },
    });

    expect(response.statusCode).toBe(200);
    const savedKeyword = saved
      .json()
      .components.find(
        (component: { id: string }) => component.id === "keyword-ranking",
      );
    const previewKeyword = response
      .json()
      .components.find(
        (component: { id: string }) => component.id === "keyword-ranking",
      );
    expect(previewKeyword.currentFingerprint).not.toBe(
      savedKeyword.currentFingerprint,
    );
    expect(previewKeyword.selectedByDefault).toBe(true);
  });

  test("queues, lists, reads and cancels a run while enforcing single-flight", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations",
      payload: {
        name: "Before BM25 change",
        queryLimit: 10,
        components: ["keyword-ranking"],
        settingsOverrides: { bm25K1: 0.6, bm25B: 0.35 },
      },
    });
    expect(start.statusCode).toBe(200);
    const run = start.json();
    expect(run).toMatchObject({
      name: "Before BM25 change",
      status: "queued",
      stage: "queued",
      selectedComponents: ["keyword-ranking"],
      settingsOverrides: { bm25K1: 0.6, bm25B: 0.35 },
    });
    expect(run.taskId).toEqual(expect.any(String));

    const conflict = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations",
      payload: {},
    });
    expect(conflict.statusCode).toBe(409);

    const list = await app.inject({
      method: "GET",
      url: "/api/organization/knowledge-settings/retrieval-evaluations?limit=5",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].settingsOverrides).toEqual({
      bm25K1: 0.6,
      bm25B: 0.35,
    });
    expect(list.json()[0]).not.toHaveProperty("artifact");

    const detail = await app.inject({
      method: "GET",
      url: `/api/organization/knowledge-settings/retrieval-evaluations/${run.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(run.id);
    expect(detail.json().settingsOverrides).toEqual({
      bm25K1: 0.6,
      bm25B: 0.35,
    });

    const cancel = await app.inject({
      method: "POST",
      url: `/api/organization/knowledge-settings/retrieval-evaluations/${run.id}/cancel`,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("cancelled");

    await waitForAuditRows(organizationId, 3);
    const { data: auditRows } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "retrievalEvaluation",
      sortDirection: "asc",
      limit: 10,
      offset: 0,
    });
    const successful = auditRows.filter((row) => row.outcome === "success");
    expect(successful.map((row) => row.action)).toEqual([
      "retrievalEvaluation.started",
      "retrievalEvaluation.cancelled",
    ]);
    expect(successful[0].after).not.toHaveProperty("artifact");
    expect(successful[0].after).toMatchObject({
      settingsOverrides: { bm25K1: 0.6, bm25B: 0.35 },
    });
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "retrievalEvaluation.started",
          outcome: "failure",
        }),
      ]),
    );
  });

  test("rejects comparison until both runs have artifacts", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations",
      payload: {},
    });
    const firstRun = first.json();
    await app.inject({
      method: "POST",
      url: `/api/organization/knowledge-settings/retrieval-evaluations/${firstRun.id}/cancel`,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations",
      payload: {},
    });
    const secondRun = second.json();

    const response = await app.inject({
      method: "GET",
      url: `/api/organization/knowledge-settings/retrieval-evaluations/${firstRun.id}/compare/${secondRun.id}`,
    });
    expect(response.statusCode).toBe(409);
  });

  test("rejects an empty component selection", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations",
      payload: { components: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  test("rejects invalid or unknown temporary settings", async () => {
    const outOfRange = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations",
      payload: { settingsOverrides: { bm25B: 1.5 } },
    });
    expect(outOfRange.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations",
      payload: { settingsOverrides: { rawApiKey: "not-allowed" } },
    });
    expect(unknown.statusCode).toBe(400);

    const invalidContextualMode = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations",
      payload: {
        settingsOverrides: { contextualRetrievalMode: "per-paragraph" },
      },
    });
    expect(invalidContextualMode.statusCode).toBe(400);

    const invalidPreview = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations/capabilities/preview",
      payload: { bm25B: 1.5 },
    });
    expect(invalidPreview.statusCode).toBe(400);
  });

  test("hides every evaluator API when the beta flag is off", async () => {
    config.kb.evaluationEnabled = false;
    const capabilities = await app.inject({
      method: "GET",
      url: "/api/organization/knowledge-settings/retrieval-evaluations/capabilities",
    });
    const start = await app.inject({
      method: "POST",
      url: "/api/organization/knowledge-settings/retrieval-evaluations",
      payload: { components: ["chunking"] },
    });
    expect(capabilities.statusCode).toBe(404);
    expect(start.statusCode).toBe(404);
  });
});

async function waitForAuditRows(
  organizationId: string,
  expected: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { data } = await AuditLogModel.findPaginated({
          organizationId,
          resourceType: "retrievalEvaluation",
          limit: 10,
          offset: 0,
        });
        return data.length;
      },
      { timeout: 2_000 },
    )
    .toBeGreaterThanOrEqual(expected);
}
