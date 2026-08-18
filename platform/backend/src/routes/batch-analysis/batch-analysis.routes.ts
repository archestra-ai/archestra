import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  retryBatchAnalysisCell,
  startBatchAnalysisRun,
} from "@/batch-analysis/runner";
import {
  AgentModel,
  BatchAnalysisModel,
  KbFileModel,
  TeamModel,
} from "@/models";
import type { BatchAnalysisViewer } from "@/models/batch-analysis";
import { CellVerificationError } from "@/models/batch-analysis";
import UserModel from "@/models/user";
import {
  ApiError,
  BatchAnalysisCellWithVerifierSchema,
  BatchAnalysisColumnsSchema,
  BatchAnalysisRowSourceSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ResourceVisibilityScopeSchema,
  SelectBatchAnalysisCellSchema,
  SelectBatchAnalysisRowSchema,
  SelectBatchAnalysisRunSchema,
  SelectBatchAnalysisSchema,
} from "@/types";

const AnalysisParamsSchema = z.object({ analysisId: z.string().uuid() });

/**
 * The full configuration of an analysis. Create and update take the same shape
 * — editing must be able to change everything creating could set, or a mistake
 * in the wizard can only be fixed by starting over.
 */
const AnalysisConfigSchema = z.object({
  name: z.string().trim().min(1).max(256),
  agentId: z.string().uuid(),
  columns: BatchAnalysisColumnsSchema,
  scope: ResourceVisibilityScopeSchema.default("personal"),
  /** Only meaningful for `scope: "team"`; ignored otherwise. */
  teamIds: z.array(z.string()).default([]),
});

/** An analysis plus the teams it is shared with, for the visibility badge. */
const BatchAnalysisListItemSchema = SelectBatchAnalysisSchema.extend({
  teamIds: z.array(z.string()),
});

/**
 * A row plus, for uploaded-file sources, the repository file it reads —
 * resolved through the CALLER's visibility, so it is null when the viewer of a
 * shared analysis cannot see the underlying (e.g. private) file. The UI offers
 * a source preview exactly when this is present.
 */
const BatchAnalysisRowWithFileSchema = SelectBatchAnalysisRowSchema.extend({
  sourceFile: z
    .object({
      id: z.string(),
      filename: z.string(),
      mimeType: z.string(),
    })
    .nullable(),
});

const BatchAnalysisDetailSchema = z.object({
  analysis: BatchAnalysisListItemSchema,
  rows: z.array(BatchAnalysisRowWithFileSchema),
  cells: z.array(BatchAnalysisCellWithVerifierSchema),
  latestRun: SelectBatchAnalysisRunSchema.nullable(),
});

const batchAnalysisRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/batch-analyses",
    {
      schema: {
        operationId: RouteId.GetBatchAnalyses,
        description: "List batch analyses in the organization",
        tags: ["Batch Analysis"],
        querystring: PaginationQuerySchema.extend({
          search: z.string().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(BatchAnalysisListItemSchema),
        ),
      },
    },
    async (request) => {
      const { limit, offset, search } = request.query;
      const { items, total } = await BatchAnalysisModel.findAllByOrganization({
        organizationId: request.organizationId,
        viewer: await resolveViewer(request),
        search,
        limit,
        offset,
      });

      // Batched: the visibility badge names the teams a team-scoped analysis is
      // shared with, and a query per row would scale with the page size.
      const teamIds = await BatchAnalysisModel.findTeamIdsForAnalyses(
        items.map((analysis) => analysis.id),
      );

      return {
        data: items.map((analysis) => ({
          ...analysis,
          teamIds: teamIds.get(analysis.id) ?? [],
        })),
        pagination: calculatePaginationMeta(total, { limit, offset }),
      };
    },
  );

  fastify.post(
    "/api/batch-analyses",
    {
      schema: {
        operationId: RouteId.CreateBatchAnalysis,
        description:
          "Create a batch analysis: a set of columns to evaluate against a set of rows",
        tags: ["Batch Analysis"],
        body: AnalysisConfigSchema,
        response: constructResponseSchema(BatchAnalysisListItemSchema),
      },
    },
    async ({ body, organizationId, user }) => {
      await assertAgentInOrg({ agentId: body.agentId, organizationId });
      await assertTeamsInOrg({ teamIds: body.teamIds, organizationId });

      const analysis = await BatchAnalysisModel.create({
        organizationId,
        name: body.name,
        agentId: body.agentId,
        columns: body.columns,
        scope: body.scope,
        createdBy: user.id,
      });

      if (body.scope === "team") {
        await BatchAnalysisModel.setTeams({
          analysisId: analysis.id,
          teamIds: body.teamIds,
        });
      }

      return {
        ...analysis,
        teamIds: body.scope === "team" ? body.teamIds : [],
      };
    },
  );

  fastify.patch(
    "/api/batch-analyses/:analysisId",
    {
      schema: {
        operationId: RouteId.UpdateBatchAnalysis,
        description: "Update a batch analysis's configuration",
        tags: ["Batch Analysis"],
        params: AnalysisParamsSchema,
        body: AnalysisConfigSchema,
        response: constructResponseSchema(BatchAnalysisListItemSchema),
      },
    },
    async (request) => {
      const { body, organizationId } = request;
      const { analysisId } = request.params;

      // Read through the viewer filter first: without it, anyone could edit a
      // personal analysis belonging to someone else by guessing its id.
      const existing = await BatchAnalysisModel.findById({
        analysisId,
        organizationId,
        viewer: await resolveViewer(request),
      });
      if (!existing) throw new ApiError(404, "Analysis not found");

      await assertAgentInOrg({ agentId: body.agentId, organizationId });
      await assertTeamsInOrg({ teamIds: body.teamIds, organizationId });

      const analysis = await BatchAnalysisModel.update({
        analysisId,
        organizationId,
        data: {
          name: body.name,
          agentId: body.agentId,
          columns: body.columns,
          scope: body.scope,
        },
      });
      if (!analysis) throw new ApiError(404, "Analysis not found");

      // Always rewritten, including to empty: leaving stale rows behind after a
      // switch away from `team` would re-share the analysis if it ever switched
      // back.
      await BatchAnalysisModel.setTeams({
        analysisId,
        teamIds: body.scope === "team" ? body.teamIds : [],
      });

      // A removed column's cells render nowhere but still count in progress
      // totals; drop them so "done/total" stays honest.
      await BatchAnalysisModel.deleteCellsForRemovedColumns({
        analysisId,
        keptColumnKeys: body.columns.map((column) => column.key),
      });

      return {
        ...analysis,
        teamIds: body.scope === "team" ? body.teamIds : [],
      };
    },
  );

  fastify.delete(
    "/api/batch-analyses/:analysisId",
    {
      schema: {
        operationId: RouteId.DeleteBatchAnalysis,
        description: "Delete a batch analysis, its rows, cells and runs",
        tags: ["Batch Analysis"],
        params: AnalysisParamsSchema,
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request) => {
      const { analysisId } = request.params;
      const existing = await BatchAnalysisModel.findById({
        analysisId,
        organizationId: request.organizationId,
        viewer: await resolveViewer(request),
      });
      if (!existing) throw new ApiError(404, "Analysis not found");

      // Rows, cells and runs cascade from the analysis row.
      const deleted = await BatchAnalysisModel.delete({
        analysisId,
        organizationId: request.organizationId,
      });
      if (!deleted) throw new ApiError(404, "Analysis not found");
      return { success: true };
    },
  );

  fastify.get(
    "/api/batch-analyses/:analysisId",
    {
      schema: {
        operationId: RouteId.GetBatchAnalysis,
        description:
          "Get a batch analysis with its rows, cells and most recent run",
        tags: ["Batch Analysis"],
        params: AnalysisParamsSchema,
        response: constructResponseSchema(BatchAnalysisDetailSchema),
      },
    },
    async (request) => {
      const { analysisId } = request.params;
      const { organizationId } = request;
      // Scoped to the caller's audience: an analysis's cells quote the source
      // documents it ran against, so a personal one must not be readable by
      // anyone who knows its id.
      const viewer = await resolveViewer(request);
      const analysis = await BatchAnalysisModel.findById({
        analysisId,
        organizationId,
        viewer,
      });
      if (!analysis) {
        throw new ApiError(404, "Analysis not found");
      }

      const rows = await BatchAnalysisModel.findRows(analysisId);
      const [teamIds, cells, latestRun, sourceFiles] = await Promise.all([
        BatchAnalysisModel.findTeamIds(analysisId),
        BatchAnalysisModel.findCellsByRows(rows.map((row) => row.id)),
        BatchAnalysisModel.findLatestRun(analysisId),
        KbFileModel.findManyByIds({
          ids: rows.flatMap((row) =>
            row.source.type === "kb_file" ? [row.source.fileId] : [],
          ),
          organizationId,
          viewer: {
            userId: viewer.userId,
            teamIds: viewer.teamIds,
            canManageAll: false,
          },
        }),
      ]);

      const verifierNames = await UserModel.getNamesByIds([
        ...new Set(
          cells.flatMap((cell) => (cell.verifiedBy ? [cell.verifiedBy] : [])),
        ),
      ]);

      const filesById = new Map(sourceFiles.map((file) => [file.id, file]));
      return {
        analysis: { ...analysis, teamIds },
        rows: rows.map((row) => {
          const file =
            row.source.type === "kb_file"
              ? filesById.get(row.source.fileId)
              : undefined;
          return {
            ...row,
            sourceFile: file
              ? {
                  id: file.id,
                  filename: file.filename,
                  mimeType: file.mimeType,
                }
              : null,
          };
        }),
        cells: cells.map((cell) => ({
          ...cell,
          verifiedByName: cell.verifiedBy
            ? (verifierNames.get(cell.verifiedBy) ?? null)
            : null,
        })),
        latestRun,
      };
    },
  );

  fastify.post(
    "/api/batch-analyses/:analysisId/rows",
    {
      schema: {
        operationId: RouteId.AddBatchAnalysisRows,
        description: "Add rows (inputs) to a batch analysis",
        tags: ["Batch Analysis"],
        params: AnalysisParamsSchema,
        body: z.object({
          rows: z
            .array(
              z.object({
                label: z.string().trim().min(1).max(512),
                source: BatchAnalysisRowSourceSchema,
              }),
            )
            .min(1)
            .max(500),
        }),
        response: constructResponseSchema(
          z.object({ rows: z.array(SelectBatchAnalysisRowSchema) }),
        ),
      },
    },
    async (request) => {
      const { analysisId } = request.params;
      const { body, organizationId } = request;
      const analysis = await BatchAnalysisModel.findById({
        analysisId,
        organizationId,
        viewer: await resolveViewer(request),
      });
      if (!analysis) {
        throw new ApiError(404, "Analysis not found");
      }

      // Append after whatever is already there, so row order is stable across
      // repeated additions and matches what a reader saw last time.
      const existing = await BatchAnalysisModel.findRows(analysisId);
      const rows = await BatchAnalysisModel.addRows(
        analysisId,
        body.rows.map((row, index) => ({
          label: row.label,
          source: row.source,
          sortIndex: existing.length + index,
        })),
      );

      return { rows };
    },
  );

  fastify.delete(
    "/api/batch-analyses/:analysisId/rows/:rowId",
    {
      schema: {
        operationId: RouteId.DeleteBatchAnalysisRow,
        description: "Delete a row and its cells",
        tags: ["Batch Analysis"],
        params: AnalysisParamsSchema.extend({ rowId: z.string().uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request) => {
      const { analysisId, rowId } = request.params;
      await assertAnalysisVisible(request, analysisId);
      const deleted = await BatchAnalysisModel.deleteRow({ analysisId, rowId });
      if (!deleted) throw new ApiError(404, "Row not found");
      return { success: true };
    },
  );

  fastify.post(
    "/api/batch-analyses/:analysisId/runs",
    {
      schema: {
        operationId: RouteId.StartBatchAnalysisRun,
        description:
          "Dispatch a run. Only cells that are not already done are queued, so this both starts and resumes.",
        tags: ["Batch Analysis"],
        params: AnalysisParamsSchema,
        response: constructResponseSchema(SelectBatchAnalysisRunSchema),
      },
    },
    async (request) => {
      const { analysisId } = request.params;
      // Dispatching spends the analysis's agent credential, so it needs the
      // same audience check reading it does — otherwise an analysis you cannot
      // see is still one you can run.
      await assertAnalysisVisible(request, analysisId);
      return startBatchAnalysisRun({
        analysisId,
        organizationId: request.organizationId,
      });
    },
  );

  fastify.post(
    "/api/batch-analyses/:analysisId/rows/:rowId/cells/:columnKey/retry",
    {
      schema: {
        operationId: RouteId.RetryBatchAnalysisCell,
        description: "Reset a single cell and dispatch just that cell",
        tags: ["Batch Analysis"],
        params: AnalysisParamsSchema.extend({
          rowId: z.string().uuid(),
          columnKey: z.string().min(1).max(64),
        }),
        response: constructResponseSchema(SelectBatchAnalysisRunSchema),
      },
    },
    async (request) => {
      const { analysisId, rowId, columnKey } = request.params;
      await assertAnalysisVisible(request, analysisId);
      return retryBatchAnalysisCell({
        analysisId,
        organizationId: request.organizationId,
        rowId,
        columnKey,
      });
    },
  );

  fastify.patch(
    "/api/batch-analyses/:analysisId/cells/verification",
    {
      schema: {
        operationId: RouteId.VerifyBatchAnalysisCells,
        description:
          "Mark cells as human-verified, or clear the mark. Only completed answers can be verified; regeneration clears the mark automatically.",
        tags: ["Batch Analysis"],
        params: AnalysisParamsSchema,
        body: z.object({
          entries: z
            .array(
              z.object({
                rowId: z.string().uuid(),
                columnKey: z.string().min(1).max(64),
                verified: z.boolean(),
              }),
            )
            .min(1)
            .max(500),
        }),
        response: constructResponseSchema(
          z.object({ cells: z.array(SelectBatchAnalysisCellSchema) }),
        ),
      },
    },
    async (request) => {
      const { analysisId } = request.params;
      const { entries } = request.body;
      await assertAnalysisVisible(request, analysisId);

      let cells: Awaited<
        ReturnType<typeof BatchAnalysisModel.setCellsVerification>
      >;
      try {
        cells = await BatchAnalysisModel.setCellsVerification({
          analysisId,
          userId: request.user.id,
          entries,
        });
      } catch (error) {
        if (error instanceof CellVerificationError) {
          throw new ApiError(400, error.message);
        }
        throw error;
      }
      return { cells };
    },
  );
};

// ===== internal =====

/** 404s unless the caller's audience includes the analysis. */
async function assertAnalysisVisible(
  request: { user: { id: string }; organizationId: string },
  analysisId: string,
): Promise<void> {
  const analysis = await BatchAnalysisModel.findById({
    analysisId,
    organizationId: request.organizationId,
    viewer: await resolveViewer(request),
  });
  if (!analysis) throw new ApiError(404, "Analysis not found");
}

async function resolveViewer(request: {
  user: { id: string };
  organizationId: string;
}): Promise<BatchAnalysisViewer> {
  const teams = await TeamModel.getUserTeamsForOrganization({
    userId: request.user.id,
    organizationId: request.organizationId,
  });
  return {
    userId: request.user.id,
    teamIds: teams.map((team) => team.id),
    // Deliberately false, matching the knowledge repository: listing is scoped
    // by the analysis's own audience for everyone, so an admin browsing does
    // not silently widen what a shared screen shows.
    canReadAll: false,
  };
}

/**
 * The agent supplies the model and credential a run will spend against, so it
 * has to be one this organization actually owns.
 */
async function assertAgentInOrg(params: {
  agentId: string;
  organizationId: string;
}): Promise<void> {
  const agent = await AgentModel.findById(params.agentId);
  if (!agent || agent.organizationId !== params.organizationId) {
    throw new ApiError(404, "Agent not found");
  }
}

async function assertTeamsInOrg(params: {
  teamIds: string[];
  organizationId: string;
}): Promise<void> {
  if (params.teamIds.length === 0) return;
  const teams = await TeamModel.findByOrganization(params.organizationId);
  const known = new Set(teams.map((team) => team.id));
  if (params.teamIds.some((teamId) => !known.has(teamId))) {
    throw new ApiError(400, "One or more teams are not in this organization");
  }
}

export default batchAnalysisRoutes;
