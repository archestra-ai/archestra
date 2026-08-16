// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  buildUserAccessControlList,
} from "@/knowledge-base/source-access-control";
import { DocReviewModel, KbDocumentModel } from "@/models";
import { taskQueueService } from "@/task-queue";
import { ApiError } from "@/types";

const DocReviewColumnSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  prompt: z.string().min(1),
  outputFormat: z.enum([
    "text",
    "yes_no",
    "date",
    "number",
    "list",
    "json",
  ]),
  toolName: z.string().optional(),
  toolArgs: z.record(z.unknown()).optional(),
});

const CreateDocReviewSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  knowledgeBaseId: z.string().uuid().optional(),
  columns: z.array(DocReviewColumnSchema).min(1),
  documentIds: z.array(z.string().uuid()).min(1),
});

const docReviewRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/api/doc-reviews",
    {
      schema: {
        description: "Create and start a bulk document review table",
        tags: ["Doc Reviews"],
        body: CreateDocReviewSchema,
      },
    },
    async (request, reply) => {
      const { name, description, knowledgeBaseId, columns, documentIds } =
        request.body as z.infer<typeof CreateDocReviewSchema>;
      const organizationId = request.organizationId;
      const user = request.user;

      // 1. Resolve calling user's ACL
      const userAcl = buildUserAccessControlList({
        userEmail: user.email,
        teamIds: [], // User team IDs resolved via auth if present
      });

      // 2. Fetch candidate documents and enforce ACL read permissions
      const candidateDocs = await KbDocumentModel.findByIds(documentIds);
      const accessibleDocIds = candidateDocs
        .filter((doc) => {
          if (doc.organizationId !== organizationId) return false;
          // Check overlap between document ACL and user ACL
          if (doc.acl.length === 0) return true; // org-wide default
          return doc.acl.some((entry) => userAcl.includes(entry as any));
        })
        .map((doc) => doc.id);

      if (accessibleDocIds.length === 0) {
        throw new ApiError(
          403,
          "No accessible documents found for the requested document set",
        );
      }

      // 3. Create review record and rows/cells
      const review = await DocReviewModel.create({
        organizationId,
        createdById: user.id,
        knowledgeBaseId,
        name,
        description,
        columns,
        documentIds: accessibleDocIds,
      });

      // 4. Enqueue background runner task
      await taskQueueService.enqueue({
        taskType: "doc_review_run",
        payload: {
          reviewId: review.id,
        },
      });

      return reply.status(201).send({ review });
    },
  );

  fastify.get(
    "/api/doc-reviews",
    {
      schema: {
        description: "List document reviews for organization",
        tags: ["Doc Reviews"],
        querystring: z.object({
          limit: z.coerce.number().optional().default(50),
          offset: z.coerce.number().optional().default(0),
        }),
      },
    },
    async (request, reply) => {
      const { limit, offset } = request.query as {
        limit: number;
        offset: number;
      };
      const reviews = await DocReviewModel.findByOrganization(
        request.organizationId,
        limit,
        offset,
      );

      return reply.send({ reviews });
    },
  );

  fastify.get(
    "/api/doc-reviews/:id",
    {
      schema: {
        description: "Get document review by ID",
        tags: ["Doc Reviews"],
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const review = await DocReviewModel.findById(id, request.organizationId);
      if (!review) {
        throw new ApiError(404, "Document review not found");
      }

      return reply.send({ review });
    },
  );

  fastify.get(
    "/api/doc-reviews/:id/grid",
    {
      schema: {
        description: "Get full review matrix grid",
        tags: ["Doc Reviews"],
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grid = await DocReviewModel.findGrid(id, request.organizationId);
      if (!grid) {
        throw new ApiError(404, "Document review grid not found");
      }

      return reply.send(grid);
    },
  );

  fastify.post(
    "/api/doc-reviews/:id/resume",
    {
      schema: {
        description: "Resume interrupted document review run",
        tags: ["Doc Reviews"],
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const review = await DocReviewModel.findById(id, request.organizationId);
      if (!review) {
        throw new ApiError(404, "Document review not found");
      }

      await DocReviewModel.updateStatus(id, "running");

      await taskQueueService.enqueue({
        taskType: "doc_review_run",
        payload: { reviewId: id },
      });

      return reply.send({ success: true, status: "running" });
    },
  );

  fastify.post(
    "/api/doc-reviews/:id/cells/:cellId/retry",
    {
      schema: {
        description: "Retry single cell execution in document review",
        tags: ["Doc Reviews"],
        params: z.object({ id: z.string().uuid(), cellId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { cellId } = request.params as { id: string; cellId: string };
      const result = await DocReviewModel.retryCell(cellId, request.organizationId);
      if (!result) {
        throw new ApiError(404, "Review cell not found");
      }

      await taskQueueService.enqueue({
        taskType: "doc_review_batch",
        payload: {
          reviewId: result.review.id,
          rowIds: [result.cell.rowId],
        },
      });

      return reply.send({ success: true, cell: result.cell });
    },
  );

  fastify.delete(
    "/api/doc-reviews/:id",
    {
      schema: {
        description: "Delete document review table",
        tags: ["Doc Reviews"],
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const deleted = await DocReviewModel.delete(id, request.organizationId);
      if (!deleted) {
        throw new ApiError(404, "Document review not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/doc-reviews/:id/export",
    {
      schema: {
        description: "Export review grid matrix to CSV or JSON",
        tags: ["Doc Reviews"],
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          format: z.enum(["csv", "json"]).optional().default("csv"),
        }),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { format } = request.query as { format: "csv" | "json" };

      const grid = await DocReviewModel.findGrid(id, request.organizationId);
      if (!grid) {
        throw new ApiError(404, "Document review not found");
      }

      if (format === "json") {
        return reply
          .header(
            "Content-Disposition",
            `attachment; filename="${grid.review.name.toLowerCase().replace(/\s+/g, "_")}_review.json"`,
          )
          .send(grid);
      }

      // Generate CSV
      const headers = ["Document Title", ...grid.columns.map((c) => c.title)];
      const csvRows = [headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(",")];

      for (const row of grid.rows) {
        const rowCells = [
          `"${row.documentTitle.replace(/"/g, '""')}"`,
          ...grid.columns.map((col) => {
            const cell = row.cells[col.id];
            const val = cell?.value !== undefined && cell?.value !== null
              ? typeof cell.value === "object"
                ? JSON.stringify(cell.value)
                : String(cell.value)
              : "";
            return `"${val.replace(/"/g, '""')}"`;
          }),
        ];
        csvRows.push(rowCells.join(","));
      }

      const csvContent = csvRows.join("\n");

      return reply
        .header("Content-Type", "text/csv")
        .header(
          "Content-Disposition",
          `attachment; filename="${grid.review.name.toLowerCase().replace(/\s+/g, "_")}_review.csv"`,
        )
        .send(csvContent);
    },
  );
};

export default docReviewRoutes;
