// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  MAX_PERMISSION_SYNC_INTERVAL_SECONDS,
  MIN_PERMISSION_SYNC_INTERVAL_SECONDS,
  PaginationQuerySchema,
  PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE,
  RouteId,
  TextSearchLanguageSchema,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

// 0 = follow the documents sync schedule (no interval-scheduled passes);
// anything else must clear the interval floor.
const PermissionSyncIntervalSchema = z
  .number()
  .int()
  .min(PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE)
  .refine(
    (value) =>
      value === PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE ||
      (value >= MIN_PERMISSION_SYNC_INTERVAL_SECONDS &&
        value <= MAX_PERMISSION_SYNC_INTERVAL_SECONDS),
    {
      message: `Permission sync interval must be ${PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE} (follow the documents sync schedule) or between ${MIN_PERMISSION_SYNC_INTERVAL_SECONDS} and ${MAX_PERMISSION_SYNC_INTERVAL_SECONDS} seconds`,
    },
  );

import { isGlobalAdmin, userHasPermission } from "@/auth/utils";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import {
  AUTO_SYNC_PERMISSIONS_DISABLED_ERROR,
  checkAutoSyncPermissionSyncSupported,
  checkCanSetAutoSyncPermissionsVisibility,
  checkHasAutoSyncConnectorPermission,
  didKnowledgeSourceAclInputsChange,
  isTeamScopedWithoutTeams,
  knowledgeSourceAccessControlService,
} from "@/knowledge-base";
import {
  buildContainerToken,
  buildGroupToken,
} from "@/knowledge-base/acl-tokens";
import {
  resolveConnectorCredentials,
  resolveConnectorCredentialVersion,
} from "@/knowledge-base/connector-credentials";
import { supersedePermissionSyncAfterSettingsChange } from "@/knowledge-base/connector-settings-change";
import { extractErrorMessage } from "@/knowledge-base/connectors/base-connector";
import {
  buildGoogleDriveAuthorizationUrl,
  exchangeGoogleDriveAuthorizationCode,
  getGoogleDriveOAuthClient,
  isGoogleDriveOAuthConfigured,
  resolveGoogleDriveOAuthReturnTo,
  verifyGoogleDriveOAuthState,
} from "@/knowledge-base/connectors/gdrive/gdrive-oauth";
import { reconcileP4ShimForConnector } from "@/knowledge-base/connectors/perforce/p4-shim-service";
import { getConnector } from "@/knowledge-base/connectors/registry";
import { invalidateGroupTokenCache } from "@/knowledge-base/group-token-cache";
import {
  deleteConnector,
  deleteKnowledgeBase,
  restoreConnector,
  restoreKnowledgeBase,
} from "@/knowledge-base/knowledge-source-deletion";
import {
  mfilesAuthMethodGateViolation,
  mfilesConnectorGateViolation,
} from "@/knowledge-base/mfiles-gates";
import { nextPermissionSyncDueAt } from "@/knowledge-base/permission-sync-schedule";
import logger from "@/logging";
import {
  AgentConnectorAssignmentModel,
  AgentKnowledgeBaseModel,
  AgentModel,
  ConnectorRunModel,
  GithubAppConfigModel,
  KbContainerAclModel,
  KbDocumentModel,
  KbExternalGroupModel,
  KbExternalUserGroupModel,
  KbMemberOverrideModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  MemberModel,
  TaskModel,
} from "@/models";
import { GOOGLE_DRIVE_OAUTH_CALLBACK_PATH } from "@/routes/route-paths";
import { secretManager } from "@/secrets-manager";
import {
  assertCanAssignEnvironment,
  resolveDefaultEnvironmentForNewResource,
} from "@/services/environments/environment";
import { hiddenKnowledgeConnectorViolation } from "@/services/integration-overrides";
import { taskQueueService } from "@/task-queue";
import {
  ApiError,
  type ConnectorConfig,
  ConnectorConfigSchema,
  ConnectorCredentialsSchema,
  ConnectorRunTypeSchema,
  ConnectorSyncStatusSchema,
  type ConnectorType,
  ConnectorTypeSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  KnowledgeSourceVisibilitySchema,
  SelectConnectorRunDetailSchema,
  SelectConnectorRunListSchema,
  SelectKbDocumentSchema,
  SelectKnowledgeBaseConnectorSchema,
  SelectKnowledgeBaseSchema,
  UserSelectableConnectorTypeSchema,
} from "@/types";
import {
  BulkDeleteBodySchema,
  BulkIdsSchema,
  BulkOutcomeSchema,
  runBulk,
} from "./bulk-route";

const AssignedAgentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  agentType: z.string(),
});

const KnowledgeBaseWithConnectorsSchema = SelectKnowledgeBaseSchema.extend({
  connectors: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      connectorType: ConnectorTypeSchema,
    }),
  ),
  totalDocsIndexed: z.number(),
  assignedAgents: z.array(AssignedAgentSummarySchema),
});

/**
 * `permissionSyncState` (probe cursors/fingerprints) is internal permission-
 * sync bookkeeping and never part of the API surface.
 */
const KnowledgeBaseConnectorResponseSchema =
  SelectKnowledgeBaseConnectorSchema.omit({ permissionSyncState: true });

/**
 * Connector rows can outlive the config schema that created them. Read
 * responses therefore accept an opaque object after trying the current,
 * precisely typed config union first. Create and update inputs remain strict,
 * so this only keeps existing rows reachable for inspection, repair, or
 * deletion instead of turning schema drift into a 500.
 */
const KnowledgeBaseConnectorReadResponseSchema =
  KnowledgeBaseConnectorResponseSchema.extend({
    config: z.union([ConnectorConfigSchema, z.record(z.string(), z.unknown())]),
  });

const KnowledgeBaseConnectorListItemSchema =
  KnowledgeBaseConnectorReadResponseSchema.extend({
    assignedAgents: z.array(AssignedAgentSummarySchema),
  });

// `containerKey` is internal permission-sync bookkeeping; API consumers see
// the document's EFFECTIVE audience (container tokens expanded server-side).
const KnowledgeBaseDocumentListItemSchema = SelectKbDocumentSchema.omit({
  content: true,
  containerKey: true,
}).extend({
  connectorType: ConnectorTypeSchema,
});

const KnowledgeBaseDocumentDetailSchema = SelectKbDocumentSchema.omit({
  containerKey: true,
}).extend({
  connectorType: ConnectorTypeSchema,
});

/**
 * Gate for the `status=deleted` slice of a list endpoint. Seeing the trash is
 * the delete permission's other half — the same gate that put the rows there,
 * matching how skills and projects gate theirs. No-op for the active slice,
 * which the route's declared `knowledgeSource:read` already covers.
 */
async function requireTrashAccess(params: {
  status: "active" | "deleted";
  userId: string;
  organizationId: string;
}): Promise<void> {
  if (params.status !== "deleted") return;

  const canDelete = await userHasPermission(
    params.userId,
    params.organizationId,
    "knowledgeSource",
    "delete",
  );
  if (!canDelete) {
    throw new ApiError(403, "Forbidden");
  }
}

const knowledgeBaseRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // ===== Knowledge Base CRUD =====

  fastify.get(
    "/api/knowledge-bases",
    {
      schema: {
        operationId: RouteId.GetKnowledgeBases,
        description:
          "List all knowledge bases for the organization. `status=deleted` " +
          "lists the soft-deleted ones instead — the trash view, which " +
          "requires `knowledgeSource:delete`. Search and pagination behave " +
          "identically on both slices, but the deleted slice carries identity " +
          "only: `connectors` and `assignedAgents` come back empty and " +
          "`totalDocsIndexed` zero, since those links resolve to nothing " +
          "while the knowledge base is in the trash.",
        tags: ["Knowledge Bases"],
        querystring: PaginationQuerySchema.extend({
          search: z.string().optional(),
          status: z
            .enum(["active", "deleted"])
            .default("active")
            .describe(
              "Filter by lifecycle status. `deleted` lists soft-deleted knowledge bases and requires `knowledgeSource:delete`.",
            ),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(KnowledgeBaseWithConnectorsSchema),
        ),
      },
    },
    async (
      { query: { limit, offset, search, status }, organizationId, user },
      reply,
    ) => {
      // Viewing the trash is the delete permission's other half — the same
      // gate that put the rows there, as for skills and projects. Checked
      // before the access-control context is built so a rejected caller pays
      // for neither the permission lookup nor the team-membership query.
      await requireTrashAccess({ status, userId: user.id, organizationId });

      const access =
        await knowledgeSourceAccessControlService.buildAccessControlContext({
          userId: user.id,
          organizationId,
        });

      const [knowledgeBases, total] = await Promise.all([
        KnowledgeBaseModel.findByOrganization({
          organizationId,
          limit,
          offset,
          search,
          status,
        }),
        KnowledgeBaseModel.countByOrganization({
          organizationId,
          search,
          status,
        }),
      ]);

      // The trash view renders identity and `deletedAt` only, so the four
      // enrichment queries below are skipped for it: their answers would
      // describe links no other surface resolves while the knowledge base sits
      // in the trash. Declared in the endpoint description, not silently
      // narrowed.
      if (status === "deleted") {
        return reply.send({
          data: knowledgeBases.map((kb) => ({
            ...kb,
            connectors: [],
            totalDocsIndexed: 0,
            assignedAgents: [],
          })),
          pagination: calculatePaginationMeta(total, { limit, offset }),
        });
      }

      const kbIds = knowledgeBases.map((kb) => kb.id);
      const [allConnectors, docsIndexedByKbId, agentIdsByKbId] =
        await Promise.all([
          KnowledgeBaseConnectorModel.findByKnowledgeBaseIds(kbIds, {
            canReadAll: access.canReadAll,
            viewerTeamIds: access.teamIds,
          }),
          KbDocumentModel.countByKnowledgeBaseIds(kbIds),
          AgentKnowledgeBaseModel.getAgentIdsForKnowledgeBases(kbIds),
        ]);

      // Collect all unique agent IDs and batch-fetch their names
      const allAgentIds = [...new Set([...agentIdsByKbId.values()].flat())];
      const agentDetailsMap = new Map<
        string,
        { id: string; name: string; agentType: string }
      >();
      if (allAgentIds.length > 0) {
        const agents = await AgentModel.findBasicByOrganizationIdAndIds({
          organizationId,
          agentIds: allAgentIds,
        });
        for (const agent of agents) {
          agentDetailsMap.set(agent.id, {
            id: agent.id,
            name: agent.name,
            agentType: agent.agentType,
          });
        }
      }

      const connectorsByKbId = new Map<
        string,
        { id: string; name: string; connectorType: ConnectorType }[]
      >();
      for (const connector of allConnectors) {
        const list = connectorsByKbId.get(connector.knowledgeBaseId) ?? [];
        list.push({
          id: connector.id,
          name: connector.name,
          connectorType: connector.connectorType,
        });
        connectorsByKbId.set(connector.knowledgeBaseId, list);
      }

      const data = knowledgeBases.map((kb) => ({
        ...kb,
        connectors: connectorsByKbId.get(kb.id) ?? [],
        totalDocsIndexed: docsIndexedByKbId.get(kb.id) ?? 0,
        assignedAgents: (agentIdsByKbId.get(kb.id) ?? [])
          .map((id) => agentDetailsMap.get(id))
          .filter(
            (a): a is { id: string; name: string; agentType: string } =>
              a !== undefined,
          ),
      }));

      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.post(
    "/api/knowledge-bases",
    {
      schema: {
        operationId: RouteId.CreateKnowledgeBase,
        description: "Create a new knowledge base",
        tags: ["Knowledge Bases"],
        body: z.object({
          name: z.string().min(1),
          description: z.string().optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseSchema),
      },
    },
    async ({ body, organizationId }, reply) => {
      const kg = await KnowledgeBaseModel.create({
        organizationId,
        name: body.name,
        ...(body.description !== undefined && {
          description: body.description,
        }),
      });

      return reply.send(kg);
    },
  );

  fastify.get(
    "/api/knowledge-bases/:id",
    {
      schema: {
        operationId: RouteId.GetKnowledgeBase,
        description: "Get a knowledge base by ID",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(SelectKnowledgeBaseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const kg = await findKnowledgeBaseOrThrow({
        id,
        organizationId,
        userId: user.id,
      });
      return reply.send(kg);
    },
  );

  fastify.put(
    "/api/knowledge-bases/:id",
    {
      schema: {
        operationId: RouteId.UpdateKnowledgeBase,
        description: "Update a knowledge base",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          name: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
        }),
        response: constructResponseSchema(SelectKnowledgeBaseSchema),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      await findKnowledgeBaseOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const updated = await KnowledgeBaseModel.update(id, body);
      if (!updated) {
        throw new ApiError(404, "Knowledge base not found");
      }

      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/knowledge-bases/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteKnowledgeBases,
        description:
          "Soft-delete several knowledge bases in one request, removing their " +
          "connector assignments. Ids the caller cannot see are reported in " +
          "`failed` and leave the rest of the batch applied. There is no " +
          "matching PATCH: a knowledge base has no visibility of its own — it " +
          "is reached through the connectors and documents assigned to it — " +
          "so its only editable fields are its name and description, which " +
          "are per-row by nature.",
        tags: ["Knowledge Bases"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user } = request;
      const snapshot = async (ids: string[]) => {
        const rows = await Promise.all(
          ids.map((id) => KnowledgeBaseModel.findById(id).catch(() => null)),
        );
        return {
          knowledgeBases: rows
            .filter(
              (row): row is NonNullable<typeof row> =>
                row !== null && row.organizationId === organizationId,
            )
            .map((row) => ({ id: row.id, name: row.name }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      };

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "knowledge bases bulk delete",
        notFoundMessage: "Knowledge base not found",
        unexpectedMessage: "Could not delete this knowledge base",
        // Reuses the single-resource finder per id rather than restating who
        // may see a knowledge base.
        load: async (ids) => {
          const found = new Map<
            string,
            Awaited<ReturnType<typeof findKnowledgeBaseOrThrow>>
          >();
          for (const id of ids) {
            const kb = await findKnowledgeBaseOrThrow({
              id,
              organizationId,
              userId: user.id,
            }).catch(() => null);
            if (kb) found.set(id, kb);
          }
          return found;
        },
        describe: (kb) => kb.name,
        applyEach: async (_kb, id) => {
          const success = await deleteKnowledgeBase(id);
          if (!success) {
            throw new ApiError(404, "Knowledge base not found");
          }
        },
        audit: { target: request, snapshot },
      });

      return reply.send(outcome);
    },
  );

  fastify.delete(
    "/api/knowledge-bases/:id",
    {
      schema: {
        operationId: RouteId.DeleteKnowledgeBase,
        description:
          "Delete a knowledge base and remove its connector assignments",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      await findKnowledgeBaseOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      // Soft-delete via the shared service (stamps deleted_at + invalidates the
      // knowledge-source cache). A re-delete 404s at findKnowledgeBaseOrThrow
      // above, since findById is now notDeleted-filtered — matching the prior
      // hard-delete's non-idempotent behavior.
      const success = await deleteKnowledgeBase(id);
      if (!success) {
        throw new ApiError(404, "Knowledge base not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/knowledge-bases/:id/restore",
    {
      schema: {
        operationId: RouteId.RestoreKnowledgeBase,
        description:
          "Restore a soft-deleted knowledge base. Agent assignments and " +
          "connector links survive deletion, so the restored knowledge base is " +
          "immediately live for previously-assigned agents. 404 if there is no " +
          "soft-deleted knowledge base with that id in the org.",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId }, reply) => {
      const kb = await KnowledgeBaseModel.findDeletedByIdForOrganization(
        id,
        organizationId,
      );
      if (!kb) {
        throw new ApiError(404, "Knowledge base not found");
      }

      const success = await restoreKnowledgeBase(id);
      if (!success) {
        // Restored (or purged) between the lookup and the write.
        throw new ApiError(404, "Knowledge base not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.delete(
    "/api/knowledge-bases/:id/permanent",
    {
      schema: {
        operationId: RouteId.PermanentlyDeleteKnowledgeBase,
        description:
          "Permanently destroy a soft-deleted knowledge base (global admins " +
          "only — a `knowledgeSource:delete` or `knowledgeSource:admin` grant " +
          "reaches the trash, not past it). Irreversible, with no grace " +
          "period: the row and its agent and connector assignments are " +
          "destroyed. Its connectors survive, detached. 404 if there is no " +
          "soft-deleted knowledge base with that id in the org, which is also " +
          "the answer when it is still live or the caller is not a global " +
          "admin. Restore wins a race.",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      // Checked before the knowledge base is looked up at all: a non-admin gets
      // the same 404 whatever the id, so the endpoint never confirms one
      // exists. The purge itself re-checks id, org, and soft-deleted state
      // under a row lock, so there is no separate existence read to do here.
      if (!(await isGlobalAdmin(user.id, organizationId))) {
        throw new ApiError(404, "Knowledge base not found");
      }

      // The in-transaction FOR UPDATE re-check makes a concurrent restore win
      // over the purge.
      const purged = await KnowledgeBaseModel.purge({ id, organizationId });
      if (!purged) {
        throw new ApiError(404, "Knowledge base not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/knowledge-bases/:id/health",
    {
      schema: {
        operationId: RouteId.GetKnowledgeBaseHealth,
        description: "Check the health of a knowledge base",
        tags: ["Knowledge Bases"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            status: z.enum(["healthy", "unhealthy"]),
            message: z.string().optional(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      await findKnowledgeBaseOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      // TODO: Replace with pgvector-based health check (verify vector extension,
      // check document/chunk counts, embedding processing status)
      return reply.send({
        status: "healthy" as const,
        message: "Knowledge base uses built-in pgvector RAG stack",
      });
    },
  );

  // ===== Standalone Connector Endpoints =====

  fastify.get(
    "/api/connectors",
    {
      schema: {
        operationId: RouteId.GetConnectors,
        description:
          "List all connectors for the organization. `status=deleted` lists " +
          "the soft-deleted ones instead — the trash view, which requires " +
          "`knowledgeSource:delete`. Search and connector-type filtering " +
          "behave identically on both slices; `knowledgeBaseId` is an " +
          "active-only filter and is rejected with a 400 alongside " +
          "`status=deleted`. The deleted slice carries identity only: " +
          "`assignedAgents` comes back empty, since those links resolve to " +
          "nothing while the connector is in the trash. It is also the one " +
          "slice that never hides a row whose stored `config` no longer " +
          "matches a known connector shape — the trash is the only place " +
          "restore and permanent delete are offered.",
        tags: ["Connectors"],
        querystring: PaginationQuerySchema.extend({
          knowledgeBaseId: z.string().optional(),
          search: z.string().optional(),
          connectorType: ConnectorTypeSchema.optional(),
          status: z
            .enum(["active", "deleted"])
            .default("active")
            .describe(
              "Filter by lifecycle status. `deleted` lists soft-deleted connectors and requires `knowledgeSource:delete`.",
            ),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(KnowledgeBaseConnectorListItemSchema),
        ),
      },
    },
    async (
      {
        query: {
          limit,
          offset,
          knowledgeBaseId,
          search,
          connectorType,
          status,
        },
        organizationId,
        user,
      },
      reply,
    ) => {
      // Viewing the trash is the delete permission's other half — the same
      // gate that put the rows there, as for skills and projects. Checked
      // before the access-control context is built so a rejected caller pays
      // for neither the permission lookup nor the team-membership query.
      await requireTrashAccess({ status, userId: user.id, organizationId });

      const access =
        await knowledgeSourceAccessControlService.buildAccessControlContext({
          userId: user.id,
          organizationId,
        });

      let data: Awaited<
        ReturnType<typeof KnowledgeBaseConnectorModel.findByOrganization>
      >;
      let total: number;

      // The per-knowledge-base path is the expandable sub-table's: unpaginated
      // on purpose, so a knowledge base always shows all of its connectors. It
      // is an active-knowledge-base surface and has no deleted-slice variant,
      // so the combination is rejected rather than silently answered with the
      // org-wide trash — a dropped filter reads as a scoped result that isn't.
      if (knowledgeBaseId && status === "deleted") {
        throw new ApiError(
          400,
          "knowledgeBaseId cannot be combined with status=deleted; the trash is listed org-wide",
        );
      }

      if (knowledgeBaseId) {
        await findKnowledgeBaseOrThrow({
          id: knowledgeBaseId,
          organizationId,
          userId: user.id,
        });
        data = await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
          knowledgeBaseId,
          {
            canReadAll: access.canReadAll,
            viewerTeamIds: access.teamIds,
          },
        );
        total = data.length;
      } else {
        const result =
          await KnowledgeBaseConnectorModel.findByOrganizationPaginated({
            organizationId,
            limit,
            offset,
            search,
            connectorType,
            // The uploads-backed connector is an implementation detail of the
            // knowledge-files page, not something anyone configures here: it
            // has no credentials, no schedule and nothing to sync from, and a
            // delete button on it would strand every uploaded document behind
            // it. Managed at /knowledge/files instead.
            excludeConnectorTypes: ["file_upload"],
            canReadAll: access.canReadAll,
            viewerTeamIds: access.teamIds,
            status,
          });
        data = result.data;
        total = result.total;
      }

      // The trash renders identity and `deletedAt` only, so the two agent
      // queries below are skipped for it — their answers would describe
      // assignments no surface resolves while the connector sits in the trash.
      // The schema filter is skipped too, and deliberately: it is what keeps a
      // drifted `config` off the active list, but on the trash it would strand
      // the row for good (see KnowledgeBaseConnectorListItemSchema). Declared
      // in the endpoint description, not silently narrowed.
      if (status === "deleted") {
        return reply.send({
          data: data.map((connector) => ({
            ...connector,
            assignedAgents: [],
          })),
          pagination: calculatePaginationMeta(total, { limit, offset }),
        });
      }

      // Enrich connectors with assigned agents (batch query to avoid N+1)
      const connectorIds = data.map((c) => c.id);
      const agentIdsByConnector =
        await AgentConnectorAssignmentModel.getAgentIdsForConnectors(
          connectorIds,
        );

      const allAgentIdsForConnectors = [
        ...new Set([...agentIdsByConnector.values()].flat()),
      ];
      const connectorAgentDetailsMap = new Map<
        string,
        { id: string; name: string; agentType: string }
      >();
      if (allAgentIdsForConnectors.length > 0) {
        const agents = await AgentModel.findBasicByOrganizationIdAndIds({
          organizationId,
          agentIds: allAgentIdsForConnectors,
        });
        for (const agent of agents) {
          connectorAgentDetailsMap.set(agent.id, {
            id: agent.id,
            name: agent.name,
            agentType: agent.agentType,
          });
        }
      }

      const enrichedData = data.map((connector) => ({
        ...connector,
        assignedAgents: (agentIdsByConnector.get(connector.id) ?? [])
          .map((id) => connectorAgentDetailsMap.get(id))
          .filter(
            (a): a is { id: string; name: string; agentType: string } =>
              a !== undefined,
          ),
      }));

      const validatedData = enrichedData.filter((connector) => {
        const parsed = SelectKnowledgeBaseConnectorSchema.safeParse(connector);
        if (parsed.success) return true;
        logger.warn(
          {
            connectorId: connector.id,
            connectorType: connector.connectorType,
            configType: (connector.config as Record<string, unknown> | null)
              ?.type,
            validationErrors: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
              message: i.message,
            })),
          },
          "Skipping connector with invalid persisted schema",
        );
        return false;
      });

      return reply.send({
        data: validatedData,
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.post(
    "/api/connectors",
    {
      schema: {
        operationId: RouteId.CreateConnector,
        description: "Create a new connector",
        tags: ["Connectors"],
        body: z.object({
          name: z.string().min(1),
          description: z.string().nullable().optional(),
          visibility: KnowledgeSourceVisibilitySchema.optional(),
          teamIds: z.array(z.string()).optional(),
          connectorType: UserSelectableConnectorTypeSchema,
          config: ConnectorConfigSchema,
          // optional: GitHub App connectors authenticate via a referenced
          // github_app_configs row instead of an inline secret
          credentials: ConnectorCredentialsSchema.optional(),
          schedule: z.string().optional(),
          ftsLanguage: TextSearchLanguageSchema.optional(),
          permissionSyncIntervalSeconds:
            PermissionSyncIntervalSchema.optional(),
          enabled: z.boolean().optional(),
          knowledgeBaseIds: z.array(z.string()).optional(),
          environmentId: z.string().uuid().nullable().optional(),
        }),
        response: constructResponseSchema(KnowledgeBaseConnectorResponseSchema),
      },
    },
    async ({ body, organizationId, user }, reply) => {
      const teamIds = body.teamIds ?? [];
      const visibility = body.visibility ?? "org-wide";

      const environmentId = await resolveNewConnectorEnvironmentId({
        userId: user.id,
        organizationId,
        requested: body.environmentId,
      });
      await assertEnvironmentAssignable({
        userId: user.id,
        organizationId,
        environmentId,
      });

      if (isTeamScopedWithoutTeams({ visibility, teamIds })) {
        throw new ApiError(
          400,
          "At least one team must be selected for team-scoped connectors",
        );
      }
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (
        visibility === "team-scoped" &&
        !enterpriseTier.isKnowledgeBaseActive()
      ) {
        throw new ApiError(
          403,
          "Team-scoped connectors require an enterprise license",
        );
      }
      if (visibility === "auto-sync-permissions") {
        // beta flag + enterprise license + connector-type support +
        // knowledgeSourceAutoSync:create (admin-only by default)
        const violation = await checkCanSetAutoSyncPermissionsVisibility({
          userId: user.id,
          organizationId,
          connectorType: body.connectorType,
          action: "create",
        });
        if (violation) {
          throw violation;
        }
      }
      // SPDX-SnippetEnd

      const mfilesViolation =
        mfilesConnectorGateViolation(body.connectorType) ??
        mfilesAuthMethodGateViolation({ nextConfig: body.config });
      if (mfilesViolation) {
        throw new ApiError(403, mfilesViolation);
      }

      const hiddenTypeViolation = await hiddenKnowledgeConnectorViolation({
        organizationId,
        connectorType: body.connectorType,
      });
      if (hiddenTypeViolation) {
        throw new ApiError(403, hiddenTypeViolation);
      }

      // Validate connector config
      const connectorImpl = getConnector(body.connectorType);
      const validation = await connectorImpl.validateConfig(body.config);
      if (!validation.valid) {
        throw new ApiError(
          400,
          `Invalid connector configuration: ${validation.error}`,
        );
      }

      // Validate knowledge base IDs if provided
      if (body.knowledgeBaseIds && body.knowledgeBaseIds.length > 0) {
        for (const kbId of body.knowledgeBaseIds) {
          await findKnowledgeBaseOrThrow({
            id: kbId,
            organizationId,
            userId: user.id,
          });
        }
      }

      // GitHub App connectors reference a github_app_configs row for their
      // credentials; everything else stores an inline secret.
      const appConfigRef = await resolveGithubAppConfigReference({
        config: body.config,
        organizationId,
        userId: user.id,
      });
      const usesGithubAppConfig = appConfigRef !== null;
      const requiresCredentials = body.connectorType !== "web_crawler";
      if (appConfigRef && body.config.type === "github") {
        // the App config owns the host the installation token is minted against,
        // so it is the single source of truth for the connector's API host
        body.config.githubUrl = appConfigRef.githubUrl;
      }

      // A Google Drive connector in individual mode is authorized through
      // Google after it exists — there is nothing to paste, and the refresh
      // token arrives on the OAuth callback.
      const awaitsGoogleDriveOAuth =
        body.config.type === "gdrive" && body.config.authMode === "oauth";

      let secretId: string | null = null;
      if (usesGithubAppConfig || !requiresCredentials) {
        if (body.credentials) {
          throw new ApiError(
            400,
            usesGithubAppConfig
              ? "GitHub App connectors must not include inline credentials"
              : "Web Crawler connectors must not include inline credentials",
          );
        }
      } else if (awaitsGoogleDriveOAuth) {
        if (body.credentials) {
          throw new ApiError(
            400,
            "Google Drive connectors in individual mode are authorized through Google, not with a pasted credential",
          );
        }
        const oauthClient = getGoogleDriveOAuthClient();
        if (!oauthClient) {
          throw new ApiError(
            400,
            "This deployment has no Google OAuth client configured. Set ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID and ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET.",
          );
        }
        // The secret exists from the start, holding only the client the
        // connector will be authorized against; the callback adds the token.
        const secret = await secretManager().createSecret(
          { apiToken: "", googleOAuth: { clientId: oauthClient.clientId } },
          `connector-${body.name}`,
        );
        secretId = secret.id;
      } else {
        if (!body.credentials) {
          throw new ApiError(
            400,
            "Credentials are required for this connector",
          );
        }
        const secret = await secretManager().createSecret(
          body.credentials,
          `connector-${body.name}`,
        );
        secretId = secret.id;
      }

      // Create the connector
      const connector = await KnowledgeBaseConnectorModel.create({
        organizationId,
        name: body.name,
        description: body.description ?? null,
        visibility: body.visibility,
        teamIds: body.teamIds,
        connectorType: body.connectorType,
        config: body.config,
        secretId,
        environmentId,
        schedule: body.schedule,
        ftsLanguage: body.ftsLanguage,
        permissionSyncIntervalSeconds: body.permissionSyncIntervalSeconds,
        enabled: body.enabled,
      });

      // Assign to knowledge bases if provided. The ids were validated above;
      // a false here means one was deleted in between.
      if (body.knowledgeBaseIds && body.knowledgeBaseIds.length > 0) {
        for (const kbId of body.knowledgeBaseIds) {
          const assigned =
            await KnowledgeBaseConnectorModel.assignToKnowledgeBase(
              connector.id,
              kbId,
            );
          if (!assigned) {
            throw new ApiError(404, "Knowledge base not found");
          }
        }
      }

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // A Perforce connector created to sync permissions gets its shim now
      // rather than on its first pass, so the pod is scheduled and its image
      // pulled before anything needs it.
      await reconcileP4ShimForConnector(connector.id);
      // SPDX-SnippetEnd

      // A connector still waiting on its Google authorization has no
      // credential to sync with, so the first run would only produce a
      // failure to explain something the UI already says. The OAuth callback
      // enqueues it the moment there is a token.
      if (awaitsGoogleDriveOAuth) {
        return reply.send(connector);
      }

      // Auto-trigger initial sync. "queued" (not "running"): the worker
      // stamps "running" when it actually claims the task.
      await taskQueueService.enqueue({
        taskType: "connector_sync",
        payload: { connectorId: connector.id },
      });
      const updatedConnector = await KnowledgeBaseConnectorModel.update(
        connector.id,
        { lastSyncStatus: "queued" },
      );

      return reply.send(updatedConnector ?? connector);
    },
  );

  fastify.get(
    "/api/connectors/:id",
    {
      schema: {
        operationId: RouteId.GetConnector,
        description: "Get a connector by ID",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          KnowledgeBaseConnectorReadResponseSchema.extend({
            totalDocsIngested: z.number(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });
      const totalDocsIngested = await KbDocumentModel.countByConnector(id);
      return reply.send({ ...connector, totalDocsIngested });
    },
  );

  fastify.get(
    "/api/connectors/:id/documents",
    {
      schema: {
        operationId: RouteId.GetConnectorDocuments,
        description: "List documents for a connector",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        querystring: PaginationQuerySchema.extend({
          search: z.string().optional(),
          group: z
            .string()
            .describe(
              "Only documents whose effective audience grants this upstream group (auto-sync-permissions connectors)",
            )
            .optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(KnowledgeBaseDocumentListItemSchema),
        ),
      },
    },
    async (
      {
        params: { id },
        query: { limit, offset, search, group },
        organizationId,
        user,
      },
      reply,
    ) => {
      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });
      const groupToken = group
        ? buildGroupToken({
            connectorType: connector.connectorType,
            groupId: group,
          })
        : undefined;

      const [data, total] = await Promise.all([
        KbDocumentModel.findListItemsByConnector({
          connectorId: id,
          organizationId,
          limit,
          offset,
          search,
          groupToken,
        }),
        KbDocumentModel.countByConnectorWithSearch({
          connectorId: id,
          organizationId,
          search,
          groupToken,
        }),
      ]);

      return reply.send({
        data: await expandContainerAcls({ connectorId: id, documents: data }),
        pagination: calculatePaginationMeta(total, { limit, offset }),
      });
    },
  );

  fastify.get(
    "/api/connectors/:id/documents/:docId",
    {
      schema: {
        operationId: RouteId.GetConnectorDocument,
        description: "Get a single connector document",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid(), docId: z.uuid() }),
        response: constructResponseSchema(KnowledgeBaseDocumentDetailSchema),
      },
    },
    async ({ params: { id, docId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const existing = await KbDocumentModel.findListItemByIdAndConnector({
        documentId: docId,
        connectorId: id,
        organizationId,
      });
      if (!existing) {
        throw new ApiError(404, "Document not found");
      }

      const [expanded] = await expandContainerAcls({
        connectorId: id,
        documents: [existing],
      });
      return reply.send(expanded);
    },
  );

  fastify.delete(
    "/api/connectors/:id/documents/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteConnectorDocuments,
        description:
          "Delete several of a connector's synced documents in one request. " +
          "Ids belonging to a different connector — or to no document at all " +
          "— are reported in `failed` as not found and leave the rest of the " +
          "batch applied. Deleting a synced document removes it until the " +
          "next sync brings it back; to stop it returning, remove it at the " +
          "source or narrow the connector's scope.",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        body: z.union([
          BulkDeleteBodySchema,
          z
            .object({
              all: z
                .literal(true)
                .describe(
                  "Delete everything matching the filters below rather than " +
                    "an id list.",
                ),
              search: z
                .string()
                .optional()
                .describe("Same title search the listing applies."),
              group: z
                .string()
                .optional()
                .describe("Same group filter the listing applies."),
            })
            .describe(
              "Filter mode. A connector's corpus routinely runs to tens of " +
                "thousands of documents, which is neither a sane request body " +
                "as uuids nor worth authorizing row by row — so the filter " +
                "travels instead and the database does the work in one " +
                "statement. The response carries `affected` rather than a " +
                "per-row list.",
            ),
        ]),
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user } = request;
      const connectorId = request.params.id;

      // Request-level: the connector is the same for every document, so one
      // the caller cannot see is a 404 for the whole request rather than N
      // identical per-document failures. This is also the ONLY authorization
      // filter mode gets, which is why it is done before either branch.
      const connector = await findConnectorOrThrow({
        id: connectorId,
        organizationId,
        userId: user.id,
      });

      const body = request.body;
      if ("all" in body) {
        // `group` arrives as the bare upstream group id, exactly as it does on
        // the listing, and has to be namespaced the same way before it can
        // match a stored ACL entry. Skipping this would not fail loudly — the
        // raw id simply matches nothing, and the delete would report success
        // over zero rows while the user watched a filtered table survive.
        const affected = await KbDocumentModel.deleteByConnectorFilter({
          connectorId,
          organizationId,
          search: body.search,
          groupToken: body.group
            ? buildGroupToken({
                connectorType: connector.connectorType,
                groupId: body.group,
              })
            : undefined,
        });
        return reply.send({ affected, succeeded: [], failed: [] });
      }

      const outcome = await runBulk({
        ids: body.ids,
        logLabel: "connector documents bulk delete",
        notFoundMessage: "Document not found",
        unexpectedMessage: "Could not delete this document",
        load: async (ids) =>
          new Map(
            (
              await KbDocumentModel.findForBulkByConnector({
                documentIds: ids,
                connectorId,
                organizationId,
              })
            ).map((doc) => [doc.id, doc]),
          ),
        describe: (doc) => doc.title,
        // The return value is deliberately not checked, as the single-document
        // delete does not check it either: `load` has already established that
        // this row exists and belongs to this connector, so a delete affecting
        // no rows means it went away concurrently — which is the outcome the
        // caller asked for anyway.
        applyEach: async (_doc, id) => {
          await KbDocumentModel.delete(id);
        },
      });

      return reply.send(outcome);
    },
  );

  fastify.delete(
    "/api/connectors/:id/documents/:docId",
    {
      schema: {
        operationId: RouteId.DeleteConnectorDocument,
        description: "Delete a connector document",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid(), docId: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id, docId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const existing = await KbDocumentModel.findListItemByIdAndConnector({
        documentId: docId,
        connectorId: id,
        organizationId,
      });
      if (!existing) {
        throw new ApiError(404, "Document not found");
      }

      await KbDocumentModel.delete(docId);
      return reply.send({ success: true });
    },
  );

  fastify.put(
    "/api/connectors/:id",
    {
      schema: {
        operationId: RouteId.UpdateConnector,
        description: "Update a connector",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          name: z.string().min(1).optional(),
          description: z.string().nullable().optional(),
          visibility: KnowledgeSourceVisibilitySchema.optional(),
          teamIds: z.array(z.string()).optional(),
          config: ConnectorConfigSchema.optional(),
          // Partial on purpose: the edit dialog sends only the credential
          // fields the admin re-entered, and they merge over the stored
          // secret — so an admin API key can be added without retyping the
          // API token.
          credentials: ConnectorCredentialsSchema.partial({
            apiToken: true,
          }).optional(),
          schedule: z.string().optional(),
          ftsLanguage: TextSearchLanguageSchema.optional(),
          permissionSyncIntervalSeconds:
            PermissionSyncIntervalSchema.optional(),
          enabled: z.boolean().optional(),
          environmentId: z.string().uuid().nullable().optional(),
        }),
        response: constructResponseSchema(KnowledgeBaseConnectorResponseSchema),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      if (body.environmentId !== undefined) {
        await assertEnvironmentAssignable({
          userId: user.id,
          organizationId,
          environmentId: body.environmentId,
        });
      }

      const mfilesAuthViolation = mfilesAuthMethodGateViolation({
        nextConfig: body.config,
        existingConfig: connector.config,
      });
      if (mfilesAuthViolation) {
        throw new ApiError(403, mfilesAuthViolation);
      }

      // resolve the connector's auth shape after this update so credential
      // storage stays consistent across App <-> inline-secret transitions
      const nextConfig = body.config ?? connector.config;
      const appConfigRef = await resolveGithubAppConfigReference({
        config: nextConfig,
        organizationId,
        userId: user.id,
      });
      const usesGithubAppConfig = appConfigRef !== null;
      const requiresCredentials = connector.connectorType !== "web_crawler";
      if (appConfigRef && body.config?.type === "github") {
        // the App config owns the host the installation token is minted against
        body.config.githubUrl = appConfigRef.githubUrl;
      }

      const { credentials: _, ...updateData } = body;
      const nextVisibility = updateData.visibility ?? connector.visibility;
      const nextTeamIds = updateData.teamIds ?? connector.teamIds;

      // validate everything that can reject the request BEFORE touching any
      // secret, so a rejected update never leaves the connector with a
      // deleted or replaced credential
      if (
        isTeamScopedWithoutTeams({
          visibility: nextVisibility,
          teamIds: nextTeamIds,
        })
      ) {
        throw new ApiError(
          400,
          "At least one team must be selected for team-scoped connectors",
        );
      }
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (
        connector.visibility !== "team-scoped" &&
        nextVisibility === "team-scoped" &&
        !enterpriseTier.isKnowledgeBaseActive()
      ) {
        throw new ApiError(
          403,
          "Team-scoped connectors require an enterprise license",
        );
      }
      if (
        connector.visibility !== "auto-sync-permissions" &&
        nextVisibility === "auto-sync-permissions"
      ) {
        // Transition INTO auto-sync: beta flag + enterprise license +
        // connector-type support + knowledgeSourceAutoSync:update. An
        // existing auto-sync connector is exempt from the transition-only
        // gates (mirrors team-scoped); its mutations are covered by the
        // dedicated permission check below.
        const violation = await checkCanSetAutoSyncPermissionsVisibility({
          userId: user.id,
          organizationId,
          connectorType: connector.connectorType,
          action: "update",
        });
        if (violation) {
          throw violation;
        }
      } else if (connector.visibility === "auto-sync-permissions") {
        // Mutating a connector that already carries the auto-sync visibility
        // (settings, credentials, or switching AWAY from it): viewing rights
        // (findConnectorOrThrow above) are not enough — require the dedicated
        // update permission.
        const violation = await checkHasAutoSyncConnectorPermission({
          userId: user.id,
          organizationId,
          action: "update",
        });
        if (violation) {
          throw violation;
        }
        if (nextVisibility === "auto-sync-permissions") {
          const unsupported = checkAutoSyncPermissionSyncSupported(
            connector.connectorType,
          );
          if (unsupported) {
            throw unsupported;
          }
        }
      }
      // SPDX-SnippetEnd
      if (usesGithubAppConfig && body.credentials) {
        throw new ApiError(
          400,
          "GitHub App connectors must not include inline credentials",
        );
      }
      if (!requiresCredentials && body.credentials) {
        throw new ApiError(
          400,
          "Web Crawler connectors must not include inline credentials",
        );
      }
      const wasGithubApp =
        connector.config.type === "github" &&
        connector.config.authMethod === "github_app";
      if (
        wasGithubApp &&
        !usesGithubAppConfig &&
        !body.credentials &&
        !connector.secretId
      ) {
        // leaving App auth means the connector has no inline secret yet, so a
        // new credential must be supplied with the switch
        throw new ApiError(
          400,
          "Credentials are required when switching this connector to token authentication",
        );
      }

      let nextSecretId = connector.secretId;
      let secretToDeleteAfterUpdate: string | null = null;
      if (usesGithubAppConfig || !requiresCredentials) {
        // defer dropping the connector's own inline secret until the update has
        // been persisted, so a later failure can't orphan the connector
        if (connector.secretId) {
          secretToDeleteAfterUpdate = connector.secretId;
          nextSecretId = null;
        }
      } else if (body.credentials) {
        if (connector.secretId) {
          // The edit dialog promises "leave empty to keep existing
          // credentials" per field and omits blank fields, but updateSecret
          // replaces the whole value — merge over the stored secret so
          // rotating only the token keeps the email, and adding only the
          // admin API key keeps the token.
          const existing = await secretManager().getSecret(connector.secretId);
          const stored = (existing?.secret ?? {}) as Record<string, unknown>;
          const merged = ConnectorCredentialsSchema.safeParse({
            ...stored,
            ...body.credentials,
          });
          if (!merged.success) {
            throw new ApiError(
              400,
              "The stored credentials are incomplete — re-enter the API token",
            );
          }
          await secretManager().updateSecret(connector.secretId, merged.data);
        } else {
          const created = ConnectorCredentialsSchema.safeParse(
            body.credentials,
          );
          if (!created.success) {
            // no stored secret to merge over (e.g. leaving GitHub App auth)
            throw new ApiError(
              400,
              "An API token is required when setting credentials for the first time",
            );
          }
          const secret = await secretManager().createSecret(
            created.data,
            `connector-${body.name ?? connector.name}`,
          );
          nextSecretId = secret.id;
        }
      }

      // Reset checkpoint when config changes to force a full re-sync
      // (filters, queries, inclusion/exclusion criteria affect which items get synced)
      const updated = await KnowledgeBaseConnectorModel.update(id, {
        ...updateData,
        secretId: nextSecretId,
        ...(updateData.config ? { checkpoint: null } : {}),
      });
      if (!updated) {
        throw new ApiError(404, "Connector not found");
      }

      if (secretToDeleteAfterUpdate) {
        await secretManager().deleteSecret(secretToDeleteAfterUpdate);
      }

      if (
        didKnowledgeSourceAclInputsChange({
          current: connector,
          updates: {
            visibility: updateData.visibility,
            teamIds: updateData.teamIds,
          },
        })
      ) {
        // Bump the ACL fencing epoch so any in-flight ACL write computed against
        // the old visibility/teamIds no-ops (the newest config change wins). For
        // org-wide/team-scoped this then runs the authoritative bulk refresh; for
        // auto-sync-permissions the refresh is a no-op and the (epoch-fenced)
        // permission pass enqueued below is the authoritative writer — existing
        // docs stay fail-closed until it runs.
        await KnowledgeBaseConnectorModel.bumpAclConfigEpoch(id);
        await knowledgeSourceAccessControlService.refreshConnectorDocumentAccessControlLists(
          id,
        );

        if (
          nextVisibility === "auto-sync-permissions" &&
          connector.visibility !== "auto-sync-permissions"
        ) {
          // Switching TO auto-sync fail-closes the whole corpus; run the first
          // pass now instead of leaving everything invisible until the next
          // content ingest or interval tick. De-duplicated like every other
          // permission-sync trigger.
          const alreadyQueued = await TaskModel.hasPendingOrProcessing(
            "permission_sync",
            id,
          );
          if (!alreadyQueued) {
            await taskQueueService.enqueue({
              taskType: "permission_sync",
              payload: { connectorId: id },
            });
            logger.info(
              { connectorId: id },
              "Enqueued permission sync after visibility switch to auto-sync-permissions",
            );
          }
        }
      }

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // Last, so the replacement pass reads a connector whose ACL epoch has
      // already been bumped — enqueued before that, its own writes would be
      // fenced out by the bump it raced.
      const nextEnabled = updateData.enabled ?? connector.enabled;
      if (
        connector.visibility === "auto-sync-permissions" &&
        (updateData.config !== undefined ||
          body.credentials !== undefined ||
          nextVisibility !== "auto-sync-permissions" ||
          nextEnabled !== connector.enabled)
      ) {
        // A submitted config counts as changed without a field-by-field
        // comparison, matching the checkpoint reset above.
        await supersedePermissionSyncAfterSettingsChange({
          connectorId: id,
          visibility: nextVisibility,
          enabled: nextEnabled,
        });
      }
      // After the supersede, so the pass is stopped before the pod it was
      // talking to goes away — and unconditional, because the connector row
      // this update just wrote is the only thing that decides whether a
      // Perforce shim exists. Every field above can change the answer: the
      // server or admin user (roll the pod), the credentials (rotate its
      // token), the visibility or the enabled flag (create it, or remove it
      // along with its token and its reach into the customer's network).
      await reconcileP4ShimForConnector(id);
      // SPDX-SnippetEnd

      return reply.send(updated);
    },
  );

  fastify.patch(
    "/api/connectors/bulk",
    {
      schema: {
        operationId: RouteId.BulkUpdateConnectors,
        description:
          "Change who can see several connectors in one request. Every " +
          "connector in the batch moves to the same audience, and the ACL " +
          "refresh each one needs runs per connector exactly as the single " +
          "update runs it. `auto-sync-permissions` is deliberately not " +
          "accepted here: switching a connector to it fail-closes its whole " +
          "corpus until a permission pass completes, and it is gated on the " +
          "connector's own type, so it stays a per-connector decision.",
        tags: ["Connectors"],
        body: z.object({
          ids: BulkIdsSchema,
          visibility: z
            .enum(["org-wide", "team-scoped"])
            .describe("The audience every connector in the batch moves to."),
          teamIds: z
            .array(z.string())
            .optional()
            .describe("Only meaningful for `team-scoped`; required there."),
        }),
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user, body } = request;
      const visibility = body.visibility;
      const teamIds =
        visibility === "team-scoped" ? [...new Set(body.teamIds ?? [])] : [];

      // Request-level: the audience is the same for every connector, so an
      // unusable one is a bad request rather than N identical failures.
      if (isTeamScopedWithoutTeams({ visibility, teamIds })) {
        throw new ApiError(
          400,
          "At least one team must be selected for team-scoped connectors",
        );
      }

      const snapshot = async (ids: string[]) => {
        const rows = await Promise.all(
          ids.map((id) =>
            KnowledgeBaseConnectorModel.findById(id).catch(() => null),
          ),
        );
        return {
          connectors: rows
            .filter(
              (row): row is NonNullable<typeof row> =>
                row !== null && row.organizationId === organizationId,
            )
            .map((row) => ({
              id: row.id,
              name: row.name,
              visibility: row.visibility,
              teamIds: [...(row.teamIds ?? [])].sort(),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      };

      const outcome = await runBulk({
        ids: body.ids,
        logLabel: "connectors bulk update",
        notFoundMessage: "Connector not found",
        unexpectedMessage: "Could not update this connector",
        load: async (ids) => {
          const found = new Map<
            string,
            Awaited<ReturnType<typeof findConnectorOrThrow>>
          >();
          for (const id of ids) {
            const connector = await findConnectorOrThrow({
              id,
              organizationId,
              userId: user.id,
            }).catch(() => null);
            if (connector) found.set(id, connector);
          }
          return found;
        },
        describe: (connector) => connector.name,
        authorize: async (connector) => {
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          if (
            connector.visibility !== "team-scoped" &&
            visibility === "team-scoped" &&
            !enterpriseTier.isKnowledgeBaseActive()
          ) {
            throw new ApiError(
              403,
              "Team-scoped connectors require an enterprise license",
            );
          }
          // Moving a connector AWAY from auto-sync is a mutation of an
          // auto-sync connector, so it needs the dedicated grant — viewing
          // rights are not enough, exactly as on the single update.
          if (connector.visibility === "auto-sync-permissions") {
            const violation = await checkHasAutoSyncConnectorPermission({
              userId: user.id,
              organizationId,
              action: "update",
            });
            if (violation) {
              throw violation;
            }
          }
          // SPDX-SnippetEnd
        },
        applyEach: async (connector, id) => {
          const updated = await KnowledgeBaseConnectorModel.update(id, {
            visibility,
            teamIds,
          });
          if (!updated) {
            throw new ApiError(404, "Connector not found");
          }

          if (
            didKnowledgeSourceAclInputsChange({
              current: connector,
              updates: { visibility, teamIds },
            })
          ) {
            // Same fencing the single update performs: bump the epoch so an
            // in-flight ACL write computed against the old audience no-ops,
            // then run the authoritative refresh. Skipping it would leave
            // documents readable under the audience the batch just replaced.
            await KnowledgeBaseConnectorModel.bumpAclConfigEpoch(id);
            await knowledgeSourceAccessControlService.refreshConnectorDocumentAccessControlLists(
              id,
            );
          }
        },
        audit: { target: request, snapshot },
      });

      return reply.send(outcome);
    },
  );

  fastify.delete(
    "/api/connectors/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteConnectors,
        description:
          "Soft-delete several connectors in one request. As with the single " +
          "delete, each one's queued syncs are cancelled and its stored " +
          "credential is destroyed — a restored connector comes back disabled " +
          "and re-authenticates. A connector the caller may not delete is " +
          "reported in `failed` while the rest of the batch still applies.",
        tags: ["Connectors"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user } = request;
      const snapshot = async (ids: string[]) => {
        const rows = await Promise.all(
          ids.map((id) =>
            KnowledgeBaseConnectorModel.findById(id).catch(() => null),
          ),
        );
        return {
          connectors: rows
            .filter(
              (row): row is NonNullable<typeof row> =>
                row !== null && row.organizationId === organizationId,
            )
            .map((row) => ({
              id: row.id,
              name: row.name,
              visibility: row.visibility,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        };
      };

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "connectors bulk delete",
        notFoundMessage: "Connector not found",
        unexpectedMessage: "Could not delete this connector",
        load: async (ids) => {
          const found = new Map<
            string,
            Awaited<ReturnType<typeof findConnectorOrThrow>>
          >();
          for (const id of ids) {
            const connector = await findConnectorOrThrow({
              id,
              organizationId,
              userId: user.id,
            }).catch(() => null);
            if (connector) found.set(id, connector);
          }
          return found;
        },
        describe: (connector) => connector.name,
        authorize: async (connector) => {
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          if (connector.visibility === "auto-sync-permissions") {
            const violation = await checkHasAutoSyncConnectorPermission({
              userId: user.id,
              organizationId,
              action: "delete",
            });
            if (violation) {
              throw violation;
            }
          }
          // SPDX-SnippetEnd
        },
        applyEach: async (_connector, id) => {
          const success = await deleteConnector(id);
          if (!success) {
            throw new ApiError(404, "Connector not found");
          }
        },
        audit: { target: request, snapshot },
      });

      return reply.send(outcome);
    },
  );

  fastify.delete(
    "/api/connectors/:id",
    {
      schema: {
        operationId: RouteId.DeleteConnector,
        description: "Delete a connector",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (connector.visibility === "auto-sync-permissions") {
        const violation = await checkHasAutoSyncConnectorPermission({
          userId: user.id,
          organizationId,
          action: "delete",
        });
        if (violation) {
          throw violation;
        }
      }
      // SPDX-SnippetEnd

      // Soft-delete via the shared service: cancels queued syncs (they no longer
      // self-heal via FK cascade under soft-delete) then stamps deleted_at and
      // invalidates the knowledge-source cache. A re-delete 404s at
      // findConnectorOrThrow above.
      //
      // The connector's stored SECRET is destroyed here too (see
      // revokeConnectorSecret in the service): a stamped connector 404s from
      // every route, so the secret could never be rotated or revoked afterwards.
      // A restored connector comes back disabled and re-authenticates instead.
      const success = await deleteConnector(id);
      if (!success) {
        throw new ApiError(404, "Connector not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/connectors/:id/restore",
    {
      schema: {
        operationId: RouteId.RestoreConnector,
        description:
          "Restore a soft-deleted connector. The stored credential was " +
          "destroyed when the connector was deleted, so it is restored " +
          "DISABLED — re-authenticate, then re-enable it to resume syncing. " +
          "404 if there is no soft-deleted connector with that id in the org " +
          "that the caller may manage — restoring one is gated on the same " +
          "visibility as editing or deleting it.",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      await findDeletedConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const success = await restoreConnector(id);
      if (!success) {
        // Restored (or purged) between the lookup and the write.
        throw new ApiError(404, "Connector not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.delete(
    "/api/connectors/:id/permanent",
    {
      schema: {
        operationId: RouteId.PermanentlyDeleteConnector,
        description:
          "Permanently destroy a soft-deleted connector (global admins only — " +
          "a `knowledgeSource:delete` or `knowledgeSource:admin` grant reaches " +
          "the trash, not past it). Irreversible, with no grace period: its " +
          "synced documents and their chunks, run history, access mappings, " +
          "and assignments are all destroyed. 404 if there is no soft-deleted " +
          "connector with that id in the org, which is also the answer when it " +
          "is still live or the caller is not a global admin. Restore wins a " +
          "race.",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      // Checked before the connector is looked up at all — see the
      // knowledge-base permanent delete for why.
      if (!(await isGlobalAdmin(user.id, organizationId))) {
        throw new ApiError(404, "Connector not found");
      }

      // The in-transaction FOR UPDATE re-check makes a concurrent restore win
      // over the purge.
      const purged = await KnowledgeBaseConnectorModel.purge({
        id,
        organizationId,
      });
      if (!purged) {
        throw new ApiError(404, "Connector not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/connectors/:id/sync",
    {
      schema: {
        operationId: RouteId.SyncConnector,
        description: "Manually trigger a connector sync",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            taskId: z.string(),
            status: z.string(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const hasPendingOrProcessing = await TaskModel.hasPendingOrProcessing(
        "connector_sync",
        id,
      );
      if (hasPendingOrProcessing) {
        throw new ApiError(
          409,
          "A sync is already in progress for this connector",
        );
      }

      const taskId = await taskQueueService.enqueue({
        taskType: "connector_sync",
        payload: { connectorId: id },
      });

      // Stamp "queued" immediately so the UI can react before the worker
      // picks up the task; the worker stamps "running" when it claims it.
      await KnowledgeBaseConnectorModel.update(id, {
        lastSyncStatus: "queued",
      });

      return reply.send({ taskId, status: "enqueued" });
    },
  );

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  fastify.post(
    "/api/connectors/:id/permission-sync",
    {
      schema: {
        operationId: RouteId.TriggerPermissionSync,
        description:
          "Manually trigger a permission-sync pass for an auto-sync-permissions connector",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            taskId: z.string(),
            status: z.string(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      assertAutoSyncPermissionsFeatureEnabled();

      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      if (connector.visibility !== "auto-sync-permissions") {
        throw new ApiError(
          400,
          "Permission sync only applies to auto-sync-permissions connectors",
        );
      }
      if (!getConnector(connector.connectorType).supportsPermissionSync) {
        throw new ApiError(
          400,
          `Permission sync is not supported for ${connector.connectorType} connectors`,
        );
      }

      const hasPendingOrProcessing = await TaskModel.hasPendingOrProcessing(
        "permission_sync",
        id,
      );
      if (hasPendingOrProcessing) {
        throw new ApiError(
          409,
          "A permission sync is already in progress for this connector",
        );
      }

      const taskId = await taskQueueService.enqueue({
        taskType: "permission_sync",
        // Manual sync is the operator's "reconcile everything NOW" — always a
        // full pass, never a probe-scoped delta.
        payload: { connectorId: id, mode: "full" },
      });

      await KnowledgeBaseConnectorModel.update(id, {
        lastPermissionSyncStatus: "queued",
      });

      return reply.send({ taskId, status: "enqueued" });
    },
  );

  fastify.get(
    "/api/connectors/:id/permission-coverage",
    {
      schema: {
        operationId: RouteId.GetPermissionSyncCoverage,
        description:
          "Live ACL coverage for an auto-sync-permissions connector: how many ingested documents are tagged vs still fail-closed (awaiting a permission-sync pass)",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            totalDocuments: z.number(),
            failClosedDocuments: z.number(),
            /** A permission-sync pass is currently running. */
            permissionSyncRunning: z.boolean(),
            /** Next scheduled pass: one interval after the last pass. */
            nextScheduledAt: z.string().nullable(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      assertAutoSyncPermissionsFeatureEnabled();

      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      if (connector.visibility !== "auto-sync-permissions") {
        throw new ApiError(
          400,
          "Permission coverage only applies to auto-sync-permissions connectors",
        );
      }

      // "Running" includes a queued (pending/processing) task: a manual
      // trigger enqueues first and the run row only appears once the worker
      // claims it, so the task check keeps the UI live through that gap.
      const [coverage, hasRunningRun, hasQueuedTask] = await Promise.all([
        KbDocumentModel.getAclCoverageByConnector(id),
        ConnectorRunModel.hasRunningRun({
          connectorId: id,
          runType: "permission",
        }),
        TaskModel.hasPendingOrProcessing("permission_sync", id),
      ]);
      const permissionSyncRunning = hasRunningRun || hasQueuedTask;

      // Cadence semantics (one interval after the last pass), matching the
      // scheduler. Follow mode has no scheduled pass — the next one comes
      // from the documents-sync trigger.
      const nextScheduledAt =
        connector.permissionSyncIntervalSeconds ===
        PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE
          ? null
          : nextPermissionSyncDueAt({
              intervalSeconds: connector.permissionSyncIntervalSeconds,
              lastPermissionSyncAt: connector.lastPermissionSyncAt,
            }).toISOString();

      return reply.send({
        totalDocuments: coverage.totalDocuments,
        failClosedDocuments: coverage.failClosedDocuments,
        permissionSyncRunning,
        nextScheduledAt,
      });
    },
  );

  fastify.get(
    "/api/connectors/:id/user-groups",
    {
      schema: {
        operationId: RouteId.GetConnectorUserGroups,
        description:
          // white-label-ok: OpenAPI prose; branded per request by enrichOpenApiWithRbac (route schemas register before the branding singleton syncs)
          "Synced external user groups for an auto-sync-permissions connector: each group's member emails, the Archestra org users they resolve to, and how many documents grant the group",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            /**
             * The snapshot holds more memberships than this endpoint returns, so
             * the `members` lists below are partial. The document counts are not.
             */
            truncated: z.boolean(),
            /** Membership rows (group x account) stored for this connector. */
            totalMemberships: z.number(),
            groups: z.array(
              z.object({
                /** Upstream group identifier as the source system names it. */
                groupId: z.string(),
                /** Human-readable upstream group name, when exposed. */
                name: z.string().nullable(),
                /** The exact `group:` ACL token written on documents. */
                token: z.string(),
                /** Documents on this connector whose ACL grants the group. */
                documentCount: z.number(),
                /** Most recent membership snapshot update, if any members. */
                lastSyncedAt: z.string().nullable(),
                members: z.array(
                  z.object({
                    /** Stable upstream principal id (accountId / login). */
                    accountId: z.string(),
                    /** Upstream display name, if the source exposes one. */
                    displayName: z.string().nullable(),
                    /** Null when the upstream hides the member's email — the member is fail-closed. */
                    email: z.string().nullable(),
                    /** Upstream account classification ("app" = add-on/bot); null when the source has no notion of it. */
                    accountType: z.string().nullable(),
                    /** Org user this member resolves to; null = grant currently resolves to nobody. */
                    user: z
                      .object({
                        id: z.string(),
                        name: z.string(),
                        email: z.string(),
                      })
                      .nullable(),
                    /** How `user` resolved: a manual admin mapping or the email join; null when unresolved. */
                    resolvedVia: z.enum(["override", "email"]).nullable(),
                  }),
                ),
              }),
            ),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      assertAutoSyncPermissionsFeatureEnabled();

      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      if (connector.visibility !== "auto-sync-permissions") {
        throw new ApiError(
          400,
          "User groups only apply to auto-sync-permissions connectors",
        );
      }

      const [
        { memberships, truncated },
        totalMemberships,
        documentCounts,
        groupCatalog,
      ] = await Promise.all([
        KbExternalUserGroupModel.findMembershipsWithUsersByConnector({
          connectorId: id,
          organizationId,
          limit: MAX_USER_GROUP_MEMBERSHIPS,
        }),
        KbExternalUserGroupModel.countByConnector(id),
        KbDocumentModel.getGroupTokenDocumentCounts(id),
        KbExternalGroupModel.findByConnector(id),
      ]);

      const groups = new Map<
        string,
        {
          groupId: string;
          name: string | null;
          token: string;
          documentCount: number;
          lastSyncedAt: string | null;
          members: {
            accountId: string;
            displayName: string | null;
            email: string | null;
            accountType: string | null;
            user: { id: string; name: string; email: string } | null;
            resolvedVia: "override" | "email" | null;
          }[];
        }
      >();

      for (const catalogGroup of groupCatalog) {
        const token = buildGroupToken({
          connectorType: connector.connectorType,
          groupId: catalogGroup.groupId,
        });
        groups.set(token, {
          groupId: catalogGroup.groupId,
          name: catalogGroup.name,
          token,
          documentCount: 0,
          lastSyncedAt: catalogGroup.updatedAt.toISOString(),
          members: [],
        });
      }

      for (const membership of memberships) {
        const token = buildGroupToken({
          connectorType: connector.connectorType,
          groupId: membership.groupId,
        });
        let group = groups.get(token);
        if (!group) {
          group = {
            groupId: membership.groupId,
            name: null,
            token,
            documentCount: 0,
            lastSyncedAt: null,
            members: [],
          };
          groups.set(token, group);
        }
        group.members.push({
          accountId: membership.externalAccountId,
          displayName: membership.displayName,
          email: membership.memberEmail,
          accountType: membership.accountType,
          user: membership.user,
          resolvedVia: membership.resolvedVia,
        });
        const syncedAt = membership.updatedAt.toISOString();
        if (group.lastSyncedAt === null || syncedAt > group.lastSyncedAt) {
          group.lastSyncedAt = syncedAt;
        }
      }

      // Groups granted on documents but absent from the membership snapshot
      // still show up (with no members) — those grants resolve to nobody.
      const tokenPrefix = `group:${connector.connectorType}_`;
      for (const [token, documentCount] of documentCounts) {
        const group = groups.get(token);
        if (group) {
          group.documentCount = documentCount;
        } else {
          groups.set(token, {
            groupId: token.startsWith(tokenPrefix)
              ? token.slice(tokenPrefix.length)
              : token,
            name: null,
            token,
            documentCount,
            lastSyncedAt: null,
            members: [],
          });
        }
      }

      return reply.send({
        truncated,
        totalMemberships,
        groups: [...groups.values()].sort((a, b) =>
          a.groupId.localeCompare(b.groupId),
        ),
      });
    },
  );

  fastify.put(
    "/api/connectors/:id/member-overrides",
    {
      schema: {
        operationId: RouteId.UpsertConnectorMemberOverride,
        description:
          // white-label-ok: OpenAPI prose; branded per request by enrichOpenApiWithRbac (route schemas register before the branding singleton syncs)
          "Manually map an upstream member account to an Archestra user for an auto-sync-permissions connector — the admin escape hatch when the upstream hides the member's email from every credential",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          /** Stable upstream principal id (accountId / login) as reported in user-groups. */
          externalAccountId: z.string().min(1),
          /** The Archestra org user the account should resolve to. */
          userId: z.string().min(1),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      assertAutoSyncPermissionsFeatureEnabled();

      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      if (connector.visibility !== "auto-sync-permissions") {
        throw new ApiError(
          400,
          "Member overrides only apply to auto-sync-permissions connectors",
        );
      }

      const member = await MemberModel.getByUserId(body.userId, organizationId);
      if (!member) {
        throw new ApiError(404, "User is not a member of this organization");
      }

      await KbMemberOverrideModel.upsert({
        organizationId,
        connectorId: id,
        externalAccountId: body.externalAccountId,
        userId: body.userId,
      });
      // Overrides feed the query-time group-token join; drop the cache so the
      // mapping takes effect on the next query, not after the TTL.
      await invalidateGroupTokenCache();
      // DIRECT grants (role actors, user grants) only pick the mapping up when
      // container audiences are re-resolved — enqueue a (deduped) pass with a
      // forced audience refresh so it lands in seconds, not at the next full
      // reconcile.
      await enqueueAudienceRefreshPass(id);

      return reply.send({ success: true });
    },
  );

  fastify.delete(
    "/api/connectors/:id/member-overrides/:externalAccountId",
    {
      schema: {
        operationId: RouteId.DeleteConnectorMemberOverride,
        description:
          "Remove a manual member mapping; the member falls back to email-based resolution (fail-closed when the upstream hides their email)",
        tags: ["Connectors"],
        params: z.object({
          id: z.uuid(),
          // Path-segment assumption: every supported connector's account ids
          // are URL-safe (Atlassian accountId `557058:<uuid>`, GitHub login).
          // A future connector whose ids can contain `/` or percent-encoded
          // sequences must move this to a query/body parameter instead.
          externalAccountId: z.string().min(1),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (
      { params: { id, externalAccountId }, organizationId, user },
      reply,
    ) => {
      assertAutoSyncPermissionsFeatureEnabled();

      await findConnectorOrThrow({ id, organizationId, userId: user.id });

      const deleted = await KbMemberOverrideModel.deleteByConnectorAndAccount({
        connectorId: id,
        externalAccountId,
      });
      if (!deleted) {
        throw new ApiError(404, "Member override not found");
      }
      await invalidateGroupTokenCache();
      // Un-materialize the mapped email from any direct grants promptly (see
      // the upsert route).
      await enqueueAudienceRefreshPass(id);

      return reply.send({ success: true });
    },
  );
  // SPDX-SnippetEnd

  fastify.post(
    "/api/connectors/:id/force-resync",
    {
      schema: {
        operationId: RouteId.ForceResyncConnector,
        description:
          "Force a full re-sync: deletes all documents, chunks, run history, and resets the checkpoint",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            taskId: z.string(),
            status: z.string(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const hasPendingOrProcessing = await TaskModel.hasPendingOrProcessing(
        "connector_sync",
        id,
      );
      if (hasPendingOrProcessing) {
        throw new ApiError(
          409,
          "A sync is already in progress for this connector",
        );
      }

      // Delete all documents (chunks cascade via FK) and run history
      await KbDocumentModel.deleteByConnector(id);
      await ConnectorRunModel.deleteByConnector(id);

      // Reset connector checkpoint and sync status ("queued" until the
      // worker claims the fresh sync).
      await KnowledgeBaseConnectorModel.update(id, {
        checkpoint: null,
        lastSyncStatus: "queued",
        lastSyncAt: null,
      });

      // Enqueue a fresh sync task
      const taskId = await taskQueueService.enqueue({
        taskType: "connector_sync",
        payload: { connectorId: id },
      });

      return reply.send({ taskId, status: "enqueued" });
    },
  );

  fastify.post(
    "/api/connectors/:id/test",
    {
      schema: {
        operationId: RouteId.TestConnectorConnection,
        description: "Test a connector connection",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      // Load credentials (resolves github_app_configs references when needed).
      // A Perforce auto-sync connector reads past the secrets cache: its test
      // reconciles the permission-sync shim, and a cached password would both
      // mis-report the test and provision the pod with a retired credential.
      const credentials = await resolveConnectorCredentials(connector, {
        uncached:
          connector.connectorType === "perforce" &&
          connector.visibility === "auto-sync-permissions",
      });

      // Get the connector implementation and test
      const connectorImpl = getConnector(connector.connectorType);
      const result = await connectorImpl.testConnection({
        config: connector.config as Record<string, unknown>,
        credentials,
        identity: {
          connectorId: connector.id,
          organizationId: connector.organizationId,
          environmentId: connector.environmentId,
          secretId: connector.secretId,
          credentialVersion: await resolveConnectorCredentialVersion(
            connector.secretId,
          ),
        },
      });

      return reply.send(result);
    },
  );

  // ===== Google Drive individual (OAuth) connection =====

  fastify.post(
    "/api/connectors/:id/gdrive/oauth/start",
    {
      schema: {
        operationId: RouteId.StartGoogleDriveConnectorOAuth,
        description:
          "Begin the Google authorization-code flow for a Google Drive " +
          "connector in individual mode. Returns the URL to send the browser " +
          "to; the connector being authorized travels in a signed state " +
          "parameter, because Google matches the redirect URI exactly.",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          /** Where to land once Google is done. Confined to this deployment. */
          returnTo: z.string().optional(),
        }),
        response: constructResponseSchema(
          z.object({ authorizationUrl: z.string() }),
        ),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      const connector = await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      if (
        connector.config.type !== "gdrive" ||
        connector.config.authMode !== "oauth"
      ) {
        throw new ApiError(
          400,
          "This connector does not use individual Google account authorization",
        );
      }
      if (!isGoogleDriveOAuthConfigured()) {
        throw new ApiError(
          400,
          "This deployment has no Google OAuth client configured. Set ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID and ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET.",
        );
      }

      return reply.send({
        authorizationUrl: buildGoogleDriveAuthorizationUrl({
          connectorId: connector.id,
          userId: user.id,
          organizationId,
          returnTo: resolveGoogleDriveOAuthReturnTo(body.returnTo),
        }),
      });
    },
  );

  fastify.get(
    GOOGLE_DRIVE_OAUTH_CALLBACK_PATH,
    {
      schema: {
        operationId: RouteId.CompleteGoogleDriveConnectorOAuth,
        description:
          "Where Google returns the browser after an individual Google Drive " +
          "authorization. Requires the session of the person who started the " +
          "flow: the signed state proves only that this deployment issued a " +
          "flow, so on its own it would let one person's authorization be " +
          "redeemed onto another person's connector.",
        tags: ["Connectors"],
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
        // no `response` schema: every outcome is a redirect back into the app,
        // so the person authorizing sees the connector rather than raw JSON.
      },
    },
    async ({ query, organizationId, user }, reply) => {
      const state = query.state
        ? verifyGoogleDriveOAuthState(query.state)
        : null;

      // With no valid state there is nowhere trustworthy to return to, so
      // fall back to the knowledge page rather than honouring a raw parameter.
      const returnTo = state
        ? resolveGoogleDriveOAuthReturnTo(state.returnTo)
        : resolveGoogleDriveOAuthReturnTo(undefined);

      const failed = (message: string) =>
        reply.redirect(appendQuery(returnTo, { gdriveOauthError: message }));

      if (query.error) {
        // The person declined, or Google refused the request outright.
        return failed(
          query.error === "access_denied"
            ? "Google authorization was cancelled."
            : `Google refused the authorization: ${query.error}`,
        );
      }
      if (!state || !query.code) {
        return failed(
          "That Google authorization link is no longer valid. Start the connection again.",
        );
      }

      // The state travels through Google and back, so anyone who can start a
      // flow can hand its link to somebody else. Redeeming it against the
      // session that started it is what stops one person's Drive from being
      // attached to another person's connector.
      if (state.userId !== user.id || state.organizationId !== organizationId) {
        logger.warn(
          {
            connectorId: state.connectorId,
            stateUserId: state.userId,
            sessionUserId: user.id,
          },
          "Google Drive OAuth callback presented to a different session than started it",
        );
        return failed(
          "That Google authorization was started by a different account. Start the connection again from this connector.",
        );
      }

      let connector: Awaited<ReturnType<typeof findConnectorOrThrow>>;
      try {
        connector = await findConnectorOrThrow({
          id: state.connectorId,
          organizationId: state.organizationId,
          userId: state.userId,
        });
      } catch {
        return failed("That connector no longer exists.");
      }

      if (
        connector.config.type !== "gdrive" ||
        connector.config.authMode !== "oauth"
      ) {
        return failed(
          "That connector no longer uses individual Google account authorization.",
        );
      }

      try {
        const { refreshToken, clientId, accountEmail } =
          await exchangeGoogleDriveAuthorizationCode(query.code);

        await storeGoogleDriveOAuthConnection({
          connector,
          refreshToken,
          clientId,
          accountEmail,
        });

        // First sync now that there is finally something to sync with. Create
        // deliberately skips this for an unconnected connector.
        await taskQueueService.enqueue({
          taskType: "connector_sync",
          payload: { connectorId: connector.id },
        });
        await KnowledgeBaseConnectorModel.update(connector.id, {
          lastSyncStatus: "queued",
        });

        return reply.redirect(
          appendQuery(returnTo, {
            gdriveConnected: accountEmail ?? "the Google account",
          }),
        );
      } catch (error) {
        const message = extractErrorMessage(error);
        logger.error(
          { connectorId: connector.id, error: message },
          "Google Drive OAuth callback failed",
        );
        return failed(message);
      }
    },
  );

  // ===== Connector Knowledge Base Assignments =====

  fastify.post(
    "/api/connectors/:id/knowledge-bases",
    {
      schema: {
        operationId: RouteId.AssignConnectorToKnowledgeBases,
        description: "Assign a connector to one or more knowledge bases",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        body: z.object({
          knowledgeBaseIds: z.array(z.string()).min(1),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { id }, body, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      for (const kbId of body.knowledgeBaseIds) {
        await findKnowledgeBaseOrThrow({
          id: kbId,
          organizationId,
          userId: user.id,
        });
        const assigned =
          await KnowledgeBaseConnectorModel.assignToKnowledgeBase(id, kbId);
        if (!assigned) {
          throw new ApiError(404, "Connector or knowledge base not found");
        }
      }

      return reply.send({ success: true });
    },
  );

  fastify.delete(
    "/api/connectors/:id/knowledge-bases/:kbId",
    {
      schema: {
        operationId: RouteId.UnassignConnectorFromKnowledgeBase,
        description: "Unassign a connector from a knowledge base",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid(), kbId: z.uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id, kbId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });
      await findKnowledgeBaseOrThrow({
        id: kbId,
        organizationId,
        userId: user.id,
      });

      const success =
        await KnowledgeBaseConnectorModel.unassignFromKnowledgeBase(id, kbId);
      if (!success) {
        throw new ApiError(404, "Assignment not found");
      }

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/connectors/:id/knowledge-bases",
    {
      schema: {
        operationId: RouteId.GetConnectorKnowledgeBases,
        description: "List knowledge bases assigned to a connector",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        response: constructResponseSchema(
          z.object({
            data: z.array(SelectKnowledgeBaseSchema),
          }),
        ),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      const access =
        await knowledgeSourceAccessControlService.buildAccessControlContext({
          userId: user.id,
          organizationId,
        });
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const kbIds = await KnowledgeBaseConnectorModel.getKnowledgeBaseIds(id);
      const knowledgeBases: z.infer<typeof SelectKnowledgeBaseSchema>[] = [];

      for (const kbId of kbIds) {
        const kb = await KnowledgeBaseModel.findById(kbId);
        if (
          kb &&
          kb.organizationId === organizationId &&
          knowledgeSourceAccessControlService.canAccessKnowledgeBase(access, kb)
        ) {
          knowledgeBases.push(kb);
        }
      }

      return reply.send({ data: knowledgeBases });
    },
  );

  // ===== Connector Runs =====

  fastify.get(
    "/api/connectors/:id/runs",
    {
      schema: {
        operationId: RouteId.GetConnectorRuns,
        description: "List connector runs",
        tags: ["Connectors"],
        params: z.object({ id: z.uuid() }),
        querystring: PaginationQuerySchema.extend({
          runType: ConnectorRunTypeSchema.optional(),
          status: ConnectorSyncStatusSchema.optional(),
          result: z
            .enum(["changes", "no-changes"])
            .describe("Only runs that changed something (or nothing)")
            .optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectConnectorRunListSchema).extend({
            /**
             * Per job family: a sync task is enqueued but no worker has
             * claimed it yet (no run row exists to list). Derived from the
             * task queue, so it can never go stale the way a status stamp
             * can — the UI renders these as synthetic "Queued" rows.
             */
            queued: z.object({
              content: z.boolean(),
              permission: z.boolean(),
            }),
          }),
        ),
      },
    },
    async (
      {
        params: { id },
        query: { limit, offset, runType, status, result },
        organizationId,
        user,
      },
      reply,
    ) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      // A claimed task stays pending/processing for the whole run, so
      // "queued" is task-present AND no running run row yet.
      const [
        data,
        total,
        contentTaskActive,
        permissionTaskActive,
        contentRunning,
        permissionRunning,
      ] = await Promise.all([
        ConnectorRunModel.findByConnectorList({
          connectorId: id,
          limit,
          offset,
          runType,
          status,
          result,
        }),
        ConnectorRunModel.countByConnector({
          connectorId: id,
          runType,
          status,
          result,
        }),
        TaskModel.hasPendingOrProcessing("connector_sync", id),
        TaskModel.hasPendingOrProcessing("permission_sync", id),
        ConnectorRunModel.hasRunningRun({
          connectorId: id,
          runType: "content",
        }),
        ConnectorRunModel.hasRunningRun({
          connectorId: id,
          runType: "permission",
        }),
      ]);

      const currentPage = Math.floor(offset / limit) + 1;
      const totalPages = Math.ceil(total / limit);

      return reply.send({
        data,
        queued: {
          content: contentTaskActive && !contentRunning,
          permission: permissionTaskActive && !permissionRunning,
        },
        pagination: {
          currentPage,
          limit,
          total,
          totalPages,
          hasNext: currentPage < totalPages,
          hasPrev: currentPage > 1,
        },
      });
    },
  );

  fastify.get(
    "/api/connectors/:id/runs/:runId",
    {
      schema: {
        operationId: RouteId.GetConnectorRun,
        description: "Get a single connector run (including logs)",
        tags: ["Connectors"],
        params: z.object({
          id: z.uuid(),
          runId: z.uuid(),
        }),
        response: constructResponseSchema(SelectConnectorRunDetailSchema),
      },
    },
    async ({ params: { id, runId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const run = await ConnectorRunModel.findById(runId);
      if (!run || run.connectorId !== id) {
        throw new ApiError(404, "Connector run not found");
      }

      return reply.send(run);
    },
  );

  fastify.post(
    "/api/connectors/:id/runs/:runId/cancel",
    {
      schema: {
        operationId: RouteId.CancelConnectorRun,
        description:
          "Cancel an in-progress document sync. Documents already ingested remain available; the worker stops before writing its next source batch.",
        tags: ["Connectors"],
        params: z.object({
          id: z.uuid(),
          runId: z.uuid(),
        }),
        response: constructResponseSchema(
          z.object({ cancelled: z.literal(true) }),
        ),
      },
    },
    async ({ params: { id, runId }, organizationId, user }, reply) => {
      await findConnectorOrThrow({
        id,
        organizationId,
        userId: user.id,
      });

      const run = await ConnectorRunModel.findById(runId);
      if (!run || run.connectorId !== id) {
        throw new ApiError(404, "Connector run not found");
      }
      if (run.runType !== "content") {
        throw new ApiError(400, "Only document sync runs can be cancelled");
      }

      const cancelled = await ConnectorRunModel.cancelRunningContentRun({
        connectorId: id,
        runId,
        reason: "Sync cancelled by a user.",
      });
      if (!cancelled) {
        throw new ApiError(409, "This sync run is no longer in progress");
      }

      await Promise.all([
        TaskModel.deleteActiveForContentRun({ connectorId: id, runId }),
        KnowledgeBaseConnectorModel.markContentRunCancelledIfCurrent({
          connectorId: id,
          runId,
        }),
      ]);

      return reply.send({ cancelled: true });
    },
  );
};

export default knowledgeBaseRoutes;

// ===== Internal Helpers =====

/**
 * Membership rows the user-groups endpoint will return. The snapshot is group ×
 * account, so an instance where most people belong to most groups has far more
 * of them than it has users — and this endpoint nests every one of them into a
 * single JSON document that the browser then renders in one client-side table.
 * Past this many the response says `truncated` and the UI says so too; nobody
 * reads the two-hundred-thousandth row of an audit table, and the counts (which
 * come from aggregates, not from these rows) stay exact either way.
 */
const MAX_USER_GROUP_MEMBERSHIPS = 20_000;

/**
 * Replace a document's `container:` token with its container's materialized
 * audience so API consumers (ACL badges) always see effective principals. A
 * missing or empty container row expands to nothing — the document reads as
 * fail-closed, which is exactly what it is. Legacy materialized ACLs (no
 * container token) pass through unchanged.
 */
async function expandContainerAcls<
  T extends { acl: string[]; containerKey: string | null },
>(params: { connectorId: string; documents: T[] }): Promise<T[]> {
  const containerKeys = [
    ...new Set(
      params.documents
        .map((doc) => doc.containerKey)
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  if (containerKeys.length === 0) return params.documents;

  const audiences = await KbContainerAclModel.findAudiencesByKeys({
    connectorId: params.connectorId,
    containerKeys,
  });
  return params.documents.map((doc) => {
    if (!doc.containerKey) return doc;
    const token = buildContainerToken({
      connectorId: params.connectorId,
      containerKey: doc.containerKey,
    });
    if (!doc.acl.includes(token)) return doc;
    const audience = audiences.get(doc.containerKey) ?? [];
    return {
      ...doc,
      acl: [
        ...new Set([
          ...doc.acl.filter((entry) => entry !== token),
          ...audience,
        ]),
      ],
    };
  });
}

/**
 * Gate assigning a knowledge base / connector to an environment. Mirrors the
 * agent + MCP-catalog write paths: a restricted environment (or a restricted
 * org default when environmentId is null/omitted) requires
 * knowledgeSource:deploy-to-restricted. Also validates the environment belongs
 * to the org, preventing cross-tenant binding.
 */
async function assertEnvironmentAssignable(params: {
  userId: string;
  organizationId: string;
  environmentId: string | null;
}): Promise<void> {
  const { userId, organizationId, environmentId } = params;
  const hasKnowledgeDeploy = await userHasPermission(
    userId,
    organizationId,
    "knowledgeSource",
    "deploy-to-restricted",
  );
  await assertCanAssignEnvironment({
    environmentId,
    organizationId,
    canDeployToRestricted: hasKnowledgeDeploy,
  });
}

/**
 * The environment a new connector binds to. An explicit value in the body wins
 * (including a deliberate null, which means the default environment); omitting
 * the field defers to the org's configured landing environment for new
 * knowledge connectors.
 */
async function resolveNewConnectorEnvironmentId(params: {
  userId: string;
  organizationId: string;
  requested: string | null | undefined;
}): Promise<string | null> {
  const { userId, organizationId, requested } = params;
  if (requested !== undefined) return requested;
  return resolveDefaultEnvironmentForNewResource({
    organizationId,
    resource: "knowledgeSource",
    canDeployToRestricted: await userHasPermission(
      userId,
      organizationId,
      "knowledgeSource",
      "deploy-to-restricted",
    ),
  });
}

/**
 * BETA gate for everything auto-sync-permissions: selecting the visibility on
 * create/update and the permission-family endpoints (trigger, coverage,
 * user-groups, member overrides). Off by default; staging enables it
 * explicitly and ARCHESTRA_BETA turns it on with every other beta gate.
 */
/**
 * Enqueue a permission pass with a forced audience refresh — the follow-up to
 * a member-mapping change, whose effect on DIRECT grants (role actors, user
 * grants) only materializes when container audiences are re-resolved.
 * Deliberately NOT deduped against queued passes: an in-flight pass may
 * already be past its refresh point and a queued one lacks the flag, so
 * either could silently drop the intent; the handler defers to task backoff
 * when it loses the claim, and mapping edits are rare admin actions.
 */
async function enqueueAudienceRefreshPass(connectorId: string): Promise<void> {
  await taskQueueService.enqueue({
    taskType: "permission_sync",
    payload: { connectorId, refreshAudiences: true },
  });
}

function assertAutoSyncPermissionsFeatureEnabled(): void {
  if (!config.kb.autoSyncPermissionsEnabled) {
    throw new ApiError(403, AUTO_SYNC_PERMISSIONS_DISABLED_ERROR);
  }
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  if (!enterpriseTier.isKnowledgeBaseActive()) {
    throw new ApiError(
      403,
      "Auto-sync permissions requires an enterprise license",
    );
  }
  // SPDX-SnippetEnd
}

async function findKnowledgeBaseOrThrow(params: {
  id: string;
  organizationId: string;
  userId: string;
}) {
  const kg = await KnowledgeBaseModel.findById(params.id);
  if (!kg || kg.organizationId !== params.organizationId) {
    throw new ApiError(404, "Knowledge base not found");
  }
  return kg;
}

/**
 * Persist a completed Google authorization onto the connector.
 *
 * The refresh token joins the connector's own vaulted secret, next to the id
 * of the client that issued it. The account it belongs to is written to the
 * config instead — it is a label, not a credential, and the connector page has
 * to be able to show who is connected without unsealing a secret.
 */
async function storeGoogleDriveOAuthConnection(params: {
  connector: Awaited<ReturnType<typeof findConnectorOrThrow>>;
  refreshToken: string;
  clientId: string;
  accountEmail: string | null;
}): Promise<void> {
  const { connector, refreshToken, clientId, accountEmail } = params;
  const googleOAuth = { clientId, refreshToken };

  let secretId = connector.secretId;
  if (secretId) {
    const existing = await secretManager().getSecret(secretId);
    await secretManager().updateSecret(secretId, {
      ...((existing?.secret as Record<string, unknown>) ?? {}),
      googleOAuth,
    });
  } else {
    const secret = await secretManager().createSecret(
      { apiToken: "", googleOAuth },
      `connector-${connector.name}`,
    );
    secretId = secret.id;
  }

  await KnowledgeBaseConnectorModel.update(connector.id, {
    ...(connector.secretId ? {} : { secretId }),
    ...(connector.config.type === "gdrive"
      ? {
          config: {
            ...connector.config,
            connectedAccountEmail: accountEmail ?? undefined,
          },
        }
      : {}),
  });
}

function appendQuery(url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

async function findConnectorOrThrow(params: {
  id: string;
  organizationId: string;
  userId: string;
}) {
  const connector = await KnowledgeBaseConnectorModel.findById(params.id);
  if (!connector || connector.organizationId !== params.organizationId) {
    throw new ApiError(404, "Connector not found");
  }
  const access =
    await knowledgeSourceAccessControlService.buildAccessControlContext({
      userId: params.userId,
      organizationId: params.organizationId,
    });
  if (
    !knowledgeSourceAccessControlService.canAccessConnector(access, connector)
  ) {
    throw new ApiError(404, "Connector not found");
  }
  return connector;
}

/**
 * `findConnectorOrThrow` for the trash: resolves ONLY soft-deleted rows (the
 * ordinary lookup is `notDeleted`-filtered and would 404 every restore), and
 * applies the same management-visibility gate — team-scoped connectors need
 * team membership, `auto-sync-permissions` ones need the auto-sync grant.
 *
 * Without that second half, restore would be a by-id bypass of the visibility
 * rules every other connector mutation enforces: the trash LISTING hides those
 * rows from non-admins (buildVisibilityFilter in the model), so a delete-holder
 * outside the team could revive a connector they cannot see, edit, or delete.
 * Skill restore authorizes the deleted object the same way.
 *
 * The one asymmetry, inherited from the active list rather than introduced
 * here: `buildVisibilityFilter` short-circuits on `canReadAll`, while
 * `canAccessSource` deliberately does NOT let that bypass reach
 * `auto-sync-permissions` connectors. So a `knowledgeSource:admin` WITHOUT
 * `knowledgeSourceAutoSync:read` sees those rows listed and 404s here — the
 * same 404 they already get from edit and delete on the active list. No
 * default role holds that combination.
 */
async function findDeletedConnectorOrThrow(params: {
  id: string;
  organizationId: string;
  userId: string;
}) {
  const connector =
    await KnowledgeBaseConnectorModel.findDeletedByIdForOrganization(
      params.id,
      params.organizationId,
    );
  if (!connector) {
    throw new ApiError(404, "Connector not found");
  }
  const access =
    await knowledgeSourceAccessControlService.buildAccessControlContext({
      userId: params.userId,
      organizationId: params.organizationId,
    });
  if (
    !knowledgeSourceAccessControlService.canAccessConnector(access, connector)
  ) {
    throw new ApiError(404, "Connector not found");
  }
  return connector;
}

/**
 * Validate a connector's GitHub App reference. Returns the referenced
 * github_app_configs id when the connector uses GitHub App auth (after
 * confirming it belongs to the organization), or null otherwise.
 */
async function resolveGithubAppConfigReference(params: {
  config: ConnectorConfig;
  organizationId: string;
  userId: string;
}): Promise<{ id: string; githubUrl: string } | null> {
  const { config, organizationId, userId } = params;
  if (config.type !== "github" || config.authMethod !== "github_app") {
    return null;
  }
  if (!config.githubAppConfigId) {
    throw new ApiError(
      400,
      "GitHub App authentication requires githubAppConfigId",
    );
  }
  // referencing a stored App credential lets the connector mint installation
  // tokens, so it requires the dedicated githubAppConfig:read permission on top
  // of the connector permission the route already enforces
  const canUseAppConfig = await userHasPermission(
    userId,
    organizationId,
    "githubAppConfig",
    "read",
  );
  if (!canUseAppConfig) {
    throw new ApiError(
      403,
      "You do not have permission to use GitHub App configurations",
    );
  }
  const appConfig = await GithubAppConfigModel.findByIdForOrganization({
    id: config.githubAppConfigId,
    organizationId,
  });
  if (!appConfig) {
    throw new ApiError(
      400,
      "Referenced GitHub App configuration was not found",
    );
  }
  return { id: appConfig.id, githubUrl: appConfig.githubUrl };
}
