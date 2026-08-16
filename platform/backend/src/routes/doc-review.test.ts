// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createFastifyInstance } from "@/server";
import { describe, expect, test, vi } from "@/test";
import { DocReviewModel, KbDocumentModel, KnowledgeBaseConnectorModel } from "@/models";
import type { User } from "@/types";

// Mock task queue service enqueue
vi.mock("@/task-queue", () => ({
  taskQueueService: {
    enqueue: vi.fn().mockResolvedValue("mock-task-id"),
  },
}));

async function buildApp(user: User, organizationId: string) {
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    (request as typeof request & { user: unknown }).user = user;
    (request as typeof request & { organizationId: string }).organizationId =
      organizationId;
  });

  const { default: docReviewRoutes } = await import("./doc-review.ee");
  await app.register(docReviewRoutes);
  return app;
}

describe("DocReview REST Routes", () => {
  const orgId = "org-doc-review-test";
  const user: User = {
    id: "user-1",
    email: "user1@example.com",
    name: "User 1",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  test("POST /api/doc-reviews creates a review table and enqueues task", async () => {
    const connector = await KnowledgeBaseConnectorModel.create({
      organizationId: orgId,
      name: "Test Connector",
      connectorType: "web-scraper",
      config: { url: "https://example.com" },
    });

    const doc1 = await KbDocumentModel.create({
      organizationId: orgId,
      connectorId: connector.id,
      title: "Vendor Questionnaire A",
      content: "Data residency region is US-East. SSO is supported via SAML. Breach notice is 72h.",
      contentHash: "hash-1",
      acl: [],
    });

    const doc2 = await KbDocumentModel.create({
      organizationId: orgId,
      connectorId: connector.id,
      title: "Vendor Questionnaire B",
      content: "Data residency region is EU-West. SSO is not supported. Breach notice is 24h.",
      contentHash: "hash-2",
      acl: [],
    });

    const app = await buildApp(user, orgId);

    const res = await app.inject({
      method: "POST",
      url: "/api/doc-reviews",
      payload: {
        name: "Security Audit Q3",
        description: "Review vendor questionnaires",
        columns: [
          {
            id: "col-1",
            title: "Data Residency",
            prompt: "What is the data residency region?",
            outputFormat: "text",
          },
          {
            id: "col-2",
            title: "SSO Supported",
            prompt: "Is SSO supported?",
            outputFormat: "yes_no",
          },
        ],
        documentIds: [doc1.id, doc2.id],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.review).toBeDefined();
    expect(body.review.name).toBe("Security Audit Q3");
    expect(body.review.totalRows).toBe(2);
    expect(body.review.totalCells).toBe(4);
  });

  test("GET /api/doc-reviews lists reviews and GET /api/doc-reviews/:id/grid fetches matrix", async () => {
    const review = await DocReviewModel.create({
      organizationId: orgId,
      createdById: user.id,
      name: "List Test Review",
      columns: [
        {
          id: "col-1",
          title: "Breach Window",
          prompt: "What is the breach notice window?",
          outputFormat: "text",
        },
      ],
      documentIds: [],
    });

    const app = await buildApp(user, orgId);

    const listRes = await app.inject({
      method: "GET",
      url: "/api/doc-reviews",
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    expect(listBody.reviews.some((r: any) => r.id === review.id)).toBe(true);

    const gridRes = await app.inject({
      method: "GET",
      url: `/api/doc-reviews/${review.id}/grid`,
    });

    expect(gridRes.statusCode).toBe(200);
    const gridBody = gridRes.json();
    expect(gridBody.review.id).toBe(review.id);
    expect(gridBody.columns.length).toBe(1);
  });

  test("GET /api/doc-reviews/:id/export exports CSV", async () => {
    const review = await DocReviewModel.create({
      organizationId: orgId,
      createdById: user.id,
      name: "Export Test Review",
      columns: [
        {
          id: "c1",
          title: "Field A",
          prompt: "Extract Field A",
          outputFormat: "text",
        },
      ],
      documentIds: [],
    });

    const app = await buildApp(user, orgId);

    const exportRes = await app.inject({
      method: "GET",
      url: `/api/doc-reviews/${review.id}/export?format=csv`,
    });

    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.headers["content-type"]).toContain("text/csv");
    expect(exportRes.payload).toContain("Document Title");
    expect(exportRes.payload).toContain("Field A");
  });
});
