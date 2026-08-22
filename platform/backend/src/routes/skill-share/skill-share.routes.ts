import { DEFAULT_APP_NAME, RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import config from "@/config";
import { withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  OrganizationModel,
  PluginModel,
  SkillModel,
  SkillShareLinkModel,
} from "@/models";
import { marketplaceMaterializer } from "@/skills/marketplace";
import { isReservedMarketplaceName } from "@/skills/marketplace/manifest";
import {
  ApiError,
  type ClientType,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  deriveSkillShareLinkStatus,
  type PluginPlatform,
  PluginPlatformSchema,
  SelectSkillShareLinkSchema,
  type SkillShareLinkStatus,
  SkillShareLinkStatusSchema,
  type SkillShareLinkWithSkills,
} from "@/types";
import { getPublicRequestOrigin } from "../request-origin";
import { SKILL_MARKETPLACE_PREFIX } from "../route-paths";

const SkillShareLinkSkillSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});

const SkillShareLinkPluginSummarySchema = z.object({
  id: z.string().uuid(),
  pluginSlug: z.string(),
  displayName: z.string(),
  description: z.string(),
  clientType: z.string(),
  contentHash: z.string(),
});

/** Response shape for a single share link, with derived status + skill summaries. */
const SkillShareLinkResponseSchema = SelectSkillShareLinkSchema.omit({
  tokenHash: true,
}).extend({
  // Keep nullable persisted metadata honest in generated clients. The API
  // validates executable-link values against enums before insert.
  pluginClientType: z.string().nullable(),
  pluginPlatform: z.string().nullable(),
  status: SkillShareLinkStatusSchema,
  skills: z.array(SkillShareLinkSkillSummarySchema),
  plugins: z.array(SkillShareLinkPluginSummarySchema),
});

const SkillShareLinkBodySchema = z.object({
  // upper bound sized for the "share all org skills" UX at /connection,
  // which snapshots the full org skill set in one POST.
  skillIds: z.array(z.string().uuid()).max(500).optional(),
  pluginIds: z.array(z.string().uuid()).max(50).optional(),
  pluginPlatform: PluginPlatformSchema.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});

const CreateSkillShareLinkBodySchema = SkillShareLinkBodySchema.superRefine(
  (body, ctx) => {
    if ((body.skillIds?.length ?? 0) + (body.pluginIds?.length ?? 0) === 0) {
      ctx.addIssue({
        code: "custom",
        message: "A marketplace link must contain a skill or plugin",
      });
    }
  },
);

const CreateSkillShareLinkResponseSchema = z.object({
  link: SkillShareLinkResponseSchema,
  rawToken: z.string(),
  cloneUrl: z.string(),
  marketplaceName: z.string(),
});

const ListSkillShareLinksQuerySchema = z.object({
  skillId: z.string().uuid().optional(),
});

const ListSkillShareLinksResponseSchema = z.object({
  links: z.array(SkillShareLinkResponseSchema),
});

const skillShareRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/skill-share-links",
    {
      schema: {
        operationId: RouteId.GetSkillShareLinks,
        description:
          "List skill share links for the organization, optionally filtered by skill",
        tags: ["Skills"],
        querystring: ListSkillShareLinksQuerySchema,
        response: constructResponseSchema(ListSkillShareLinksResponseSchema),
      },
    },
    async ({ query, organizationId, user }, reply) => {
      await requireSkillAdmin({ userId: user.id, organizationId });

      const links = await SkillShareLinkModel.listByOrganization({
        organizationId,
        skillId: query.skillId,
      });

      return reply.send({
        links: links.map(toShareLinkResponse),
      });
    },
  );

  fastify.post(
    "/api/skill-share-links",
    {
      schema: {
        operationId: RouteId.CreateSkillShareLink,
        description:
          "Create a share link exposing one or more skills via the public marketplace endpoint. The raw token is returned exactly once.",
        tags: ["Skills"],
        body: CreateSkillShareLinkBodySchema,
        response: constructResponseSchema(CreateSkillShareLinkResponseSchema),
      },
    },
    async (request, reply) => {
      const { body, organizationId, user } = request;
      await requireSkillAdmin({ userId: user.id, organizationId });
      const skillIds = body.skillIds ?? [];
      const pluginIds = body.pluginIds ?? [];
      const pluginPlatform = body.pluginPlatform ?? null;

      await assertSkillsBelongToOrg({
        skillIds,
        organizationId,
      });
      const pluginClientType = await validatePluginsForLink({
        pluginIds,
        organizationId,
        userId: user.id,
        pluginPlatform,
      });

      const marketplaceName = await deriveMarketplaceName(
        organizationId,
        marketplaceKind({ skillIds, pluginIds }),
      );
      if (isReservedMarketplaceName(marketplaceName)) {
        throw new ApiError(
          400,
          `Marketplace name "${marketplaceName}" is reserved`,
        );
      }

      const expiresAt =
        body.expiresAt === undefined || body.expiresAt === null
          ? null
          : new Date(body.expiresAt);
      if (pluginIds.length > 0 && !expiresAt) {
        throw new ApiError(
          400,
          "Plugin marketplace links must have an expiration date",
        );
      }

      const { link, rawToken } = await SkillShareLinkModel.create({
        organizationId,
        createdByUserId: user.id,
        skillIds,
        pluginIds,
        pluginClientType,
        pluginPlatform,
        marketplaceName,
        name: body.name ?? null,
        expiresAt,
      });

      const origin = getPublicRequestOrigin(request);
      const cloneUrl = `${origin}${SKILL_MARKETPLACE_PREFIX}/${rawToken}/repo.git`;

      logger.info(
        {
          shareLinkId: link.id,
          organizationId,
          skillCount: link.skills.length,
          clientCount: link.plugins.length,
          createdByUserId: user.id,
        },
        "skill-share: created share link",
      );

      return reply.send({
        link: toShareLinkResponse(link),
        rawToken,
        cloneUrl,
        marketplaceName,
      });
    },
  );

  fastify.post(
    "/api/skill-share-links/:id/rotate",
    {
      schema: {
        operationId: RouteId.RotateSkillShareLink,
        description:
          "Rotate a share link: revoke it and create its replacement in one transaction, so no failure mode leaves both tokens live. The new raw token is returned exactly once.",
        tags: ["Skills"],
        params: z.object({ id: z.string().uuid() }),
        body: SkillShareLinkBodySchema,
        response: constructResponseSchema(CreateSkillShareLinkResponseSchema),
      },
    },
    async (request, reply) => {
      const { body, params, organizationId, user } = request;
      await requireSkillAdmin({ userId: user.id, organizationId });

      const existing = await SkillShareLinkModel.findByIdWithResources({
        id: params.id,
        organizationId,
      });
      if (!existing) {
        throw new ApiError(404, "Skill share link not found");
      }
      const skillIds =
        body.skillIds ?? existing.skills.map((skill) => skill.id);
      const pluginIds =
        body.pluginIds ?? existing.plugins.map((plugin) => plugin.id);
      const pluginPlatform =
        body.pluginPlatform ?? parsePluginPlatform(existing.pluginPlatform);
      if (skillIds.length === 0 && pluginIds.length === 0) {
        throw new ApiError(
          400,
          "The replacement marketplace link must contain a skill or enabled plugin",
        );
      }

      await assertSkillsBelongToOrg({
        skillIds,
        organizationId,
      });
      const pluginClientType = await validatePluginsForLink({
        pluginIds,
        organizationId,
        userId: user.id,
        pluginPlatform,
      });

      // The marketplace name is frozen at create time (clients register the
      // marketplace under it locally), so a rotation must keep the existing
      // link's name — re-deriving it would silently rename the marketplace if
      // the org's branding changed since the link was created.
      const marketplaceName = existing.marketplaceName;
      if (isReservedMarketplaceName(marketplaceName)) {
        throw new ApiError(
          400,
          `Marketplace name "${marketplaceName}" is reserved`,
        );
      }

      const expiresAt =
        body.expiresAt === undefined
          ? existing.expiresAt
          : body.expiresAt === null
            ? null
            : new Date(body.expiresAt);
      if (pluginIds.length > 0 && !expiresAt) {
        throw new ApiError(
          400,
          "Plugin marketplace links must have an expiration date",
        );
      }

      const { link, rawToken } = await withDbTransaction(async (tx) => {
        const claimed = await SkillShareLinkModel.revoke({
          id: params.id,
          organizationId,
          tx,
          onlyIfUnrevoked: true,
        });
        if (!claimed) {
          // a replayed or concurrent rotate of the same link: the loser must
          // not mint a second replacement token
          throw new ApiError(409, "Skill share link is already revoked");
        }
        return SkillShareLinkModel.create({
          organizationId,
          createdByUserId: user.id,
          skillIds,
          pluginIds,
          pluginClientType,
          pluginPlatform,
          marketplaceName,
          name: body.name ?? null,
          expiresAt,
          tx,
        });
      });

      // best-effort cleanup of the old link's materialized repo; failures must
      // not surface to the user — the rotation already committed in the DB.
      void marketplaceMaterializer
        .get()
        .revoke(params.id)
        .catch((err: unknown) => {
          logger.warn(
            { err, shareLinkId: params.id },
            "skill-share: failed to drop materialized repo after rotate",
          );
        });

      const origin = getPublicRequestOrigin(request);
      const cloneUrl = `${origin}${SKILL_MARKETPLACE_PREFIX}/${rawToken}/repo.git`;

      logger.info(
        {
          rotatedShareLinkId: params.id,
          shareLinkId: link.id,
          organizationId,
          skillCount: link.skills.length,
          clientCount: link.plugins.length,
          createdByUserId: user.id,
        },
        "skill-share: rotated share link",
      );

      const [revokedSnapshot, replacementSnapshot] = await Promise.all([
        SkillShareLinkModel.findByIdForAudit(params.id, organizationId),
        SkillShareLinkModel.findByIdForAudit(link.id, organizationId),
      ]);
      request.auditAfter = {
        revoked: revokedSnapshot,
        replacement: replacementSnapshot,
      };

      return reply.send({
        link: toShareLinkResponse(link),
        rawToken,
        cloneUrl,
        marketplaceName,
      });
    },
  );

  fastify.delete(
    "/api/skill-share-links/:id",
    {
      schema: {
        operationId: RouteId.RevokeSkillShareLink,
        description:
          "Revoke a skill share link. Idempotent: revoking an already-revoked link is a no-op.",
        tags: ["Skills"],
        params: z.object({ id: z.string().uuid() }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { id }, organizationId, user }, reply) => {
      await requireSkillAdmin({ userId: user.id, organizationId });

      const existing = await SkillShareLinkModel.findById(id);
      if (!existing || existing.organizationId !== organizationId) {
        throw new ApiError(404, "Skill share link not found");
      }

      await SkillShareLinkModel.revoke({ id, organizationId });

      // best-effort cleanup of the materialized repo; failures must not surface
      // to the user — revocation already took effect in the DB.
      void marketplaceMaterializer
        .get()
        .revoke(id)
        .catch((err: unknown) => {
          logger.warn(
            { err, shareLinkId: id },
            "skill-share: failed to drop materialized repo after revoke",
          );
        });

      logger.info(
        { shareLinkId: id, organizationId, revokedByUserId: user.id },
        "skill-share: revoked share link",
      );

      return reply.send({ success: true });
    },
  );
};

export default skillShareRoutes;

// ===== Internal helpers =====

async function requireSkillAdmin(params: {
  userId: string;
  organizationId: string;
}): Promise<void> {
  const checker = await getSkillPermissionChecker(params);
  if (!checker.isAdmin) {
    throw new ApiError(
      403,
      "Only users with skill:admin can manage skill share links",
    );
  }
}

async function assertSkillsBelongToOrg(params: {
  skillIds: string[];
  organizationId: string;
}): Promise<void> {
  const skills = await SkillModel.findByIds(params.skillIds);
  const skillMap = new Map(skills.map((s) => [s.id, s]));
  for (const skillId of params.skillIds) {
    const skill = skillMap.get(skillId);
    if (!skill || skill.organizationId !== params.organizationId) {
      // 404 (not 403) so org membership is not leaked
      throw new ApiError(404, "Skill not found");
    }
  }
}

async function validatePluginsForLink(params: {
  pluginIds: string[];
  organizationId: string;
  userId: string;
  pluginPlatform: PluginPlatform | null;
}): Promise<ClientType | null> {
  if (params.pluginIds.length === 0) return null;
  if (!config.plugins.enabled) {
    throw new ApiError(404, "Plugins are not enabled");
  }
  if (!params.pluginPlatform) {
    throw new ApiError(
      400,
      "Plugin marketplace links must declare pluginPlatform",
    );
  }
  const pluginPlatform = params.pluginPlatform;
  const [canRead, canAdmin] = await Promise.all([
    userHasPermission(params.userId, params.organizationId, "plugin", "read"),
    userHasPermission(params.userId, params.organizationId, "plugin", "admin"),
  ]);
  if (!canRead || !canAdmin) {
    throw new ApiError(
      403,
      "Only users with plugin:read and plugin:admin can publish plugins",
    );
  }
  const plugins = await PluginModel.findApprovedByIds({
    ids: params.pluginIds,
    organizationId: params.organizationId,
  });
  if (plugins.length !== new Set(params.pluginIds).size) {
    throw new ApiError(404, "Plugin not found");
  }
  const clientTypes = new Set(plugins.map((plugin) => plugin.clientType));
  if (clientTypes.size !== 1) {
    throw new ApiError(
      400,
      "A marketplace link can carry plugins for only one client type",
    );
  }
  if (
    plugins.some(
      (plugin) => !plugin.supportedPlatforms.includes(pluginPlatform),
    )
  ) {
    throw new ApiError(400, `Every plugin must support ${pluginPlatform}`);
  }
  return plugins[0].clientType;
}

function parsePluginPlatform(value: string | null): PluginPlatform | null {
  const parsed = PluginPlatformSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Deterministic marketplace name for an organization. Also used by the
 * connection-setup script endpoint, which creates share links at render time.
 *
 * The name is frozen at create time and registered in the user's local client
 * config under this exact name — changing it later would silently break every
 * installed marketplace, so we snapshot the current app+org branding now.
 *
 * Format: `<app-slug>-<org-slug>-<kind>`, where kind reflects whether the
 * generated marketplace carries skills, plugins, or both.
 * Falls back to a hex slice of the org id if both slug and name are unusable.
 */
export async function deriveMarketplaceName(
  organizationId: string,
  kind: "skills" | "plugins" | "extensions" = "skills",
): Promise<string> {
  const org = await OrganizationModel.getById(organizationId);
  const appSlug = slugify(org?.appName ?? DEFAULT_APP_NAME) || "archestra";
  const orgSlug =
    slugify(org?.slug ?? "") ||
    slugify(org?.name ?? "") ||
    hexFallback(organizationId);
  return capLength(`${appSlug}-${orgSlug}-${kind}`);
}

function marketplaceKind(params: {
  skillIds: string[];
  pluginIds: string[];
}): "skills" | "plugins" | "extensions" {
  if (params.skillIds.length === 0) return "plugins";
  if (params.pluginIds.length === 0) return "skills";
  return "extensions";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function hexFallback(organizationId: string): string {
  const cleaned = organizationId.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  return cleaned.slice(0, 8) || "default0";
}

/** Shared Claude/Codex/Copilot plugin and marketplace name limit. */
function capLength(name: string): string {
  const MAX = 64;
  return name.length <= MAX ? name : name.slice(0, MAX).replace(/-+$/g, "");
}

function toShareLinkResponse(
  link: SkillShareLinkWithSkills,
): z.infer<typeof SkillShareLinkResponseSchema> {
  const { tokenHash: _, ...rest } = link;
  const status: SkillShareLinkStatus = deriveSkillShareLinkStatus(link);
  return { ...rest, status };
}
