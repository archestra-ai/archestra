import { spawnSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { DEFAULT_APP_NAME } from "@archestra/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import config from "@/config";
import logger from "@/logging";
import {
  OrganizationModel,
  PluginModel,
  SkillFileModel,
  SkillMarketplaceRepoModel,
  SkillModel,
  SkillShareLinkModel,
} from "@/models";
import { pluginDeliveryBudgetError } from "@/plugins/delivery-budget";
import { marketplaceMaterializer } from "@/skills/marketplace";
import { serveGitHttpRequest } from "@/skills/marketplace/git-http-backend";
import { marketplaceNameFor } from "@/skills/marketplace/marketplace-name";
import type {
  MaterializePluginInput,
  MaterializeSkillInput,
} from "@/skills/marketplace/materialize";
import { MarketplaceMaterializationConflictError } from "@/skills/marketplace/materialize";
import {
  loadMarketplaceSkills,
  type MarketplaceViewer,
  resolveMarketplaceViewer,
} from "@/skills/marketplace/static-marketplace";
import { type PluginPlatform, PluginPlatformSchema } from "@/types";
import type { MarketplaceRepoRef } from "@/types/skill-share-link-revision";
import { SKILL_MARKETPLACE_STATIC_PATH } from "./route-paths";

/**
 * Public git smart-HTTP endpoints serving marketplace repositories. Both are
 * allowlisted in the auth middleware because they authenticate in-route:
 *
 * - `/skills/m/:token/repo.git` — a share link's snapshot. The URL token is
 *   the credential (validated against `skill_share_link.tokenHash`); misses,
 *   revocations, and expirations all return 404 (no leak).
 * - `/skills/marketplace.git` — the deployment's static marketplace. The URL
 *   is identical for everyone; the caller authenticates with their own
 *   personal credential over HTTP Basic and gets the skills they may read, or
 *   clones anonymously when the organization publishes that view.
 */

/**
 * Basic-auth realm on the static endpoint's challenge. Deliberately generic:
 * the header is served to unauthenticated callers, so it carries no
 * deployment or organization identity.
 */
const BASIC_AUTH_REALM = "Skills Marketplace";

const skillMarketplacePublicRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const endpoint = config.skillMarketplace.endpoint;

  fastify.addHook("onReady", async () => {
    // codegen boots fastify without initializing the DB — skip the runtime
    // probes so OpenAPI generation does not crash on a missing connection
    if (config.codegenMode) return;

    const result = spawnSync(config.git.binaryPath, ["--version"]);
    if (result.error || result.status !== 0) {
      logger.error(
        {
          gitBinaryPath: config.git.binaryPath,
          err: result.error,
          stderr: result.stderr?.toString(),
        },
        "skill-marketplace: git binary not usable — clone requests will 502 until ARCHESTRA_GIT_BINARY_PATH points at a working git",
      );
    }

    // remove on-disk repos whose owner is gone since last boot: revoked or
    // expired share links, and static repos whose org or user was deleted
    const [activeLinkIds, repoIds] = await Promise.all([
      SkillShareLinkModel.listActiveIds(),
      SkillMarketplaceRepoModel.listIds(),
    ]);
    const removed = await marketplaceMaterializer
      .get()
      .sweepOrphans([...activeLinkIds, ...repoIds]);
    if (removed.length > 0) {
      logger.info(
        { removed },
        "skill-marketplace: swept orphaned repos at startup",
      );
    }
  });

  // Fastify rejects unknown content types before the handler runs. Register a
  // catch-all no-op parser scoped to this plugin so any git content type
  // (upload-pack, receive-pack) reaches the handler where isAllowedGitPath
  // gates access. The body is NOT consumed here; the handler pipes request.raw
  // directly to git http-backend.
  fastify.addContentTypeParser("*", (_req, _payload, done) => {
    done(null);
  });

  // GET /info/refs?service=git-upload-pack and POST /git-upload-pack
  // are both served by `git http-backend` via the same handler.
  fastify.route({
    method: ["GET", "POST"],
    url: `${endpoint}/:token/repo.git/*`,
    handler: async (request, reply) => {
      const token = (request.params as { token?: string }).token ?? "";
      const subPath = (request.params as { "*"?: string })["*"] ?? "";

      // only upload-pack (read-only) is allowed; reject receive-pack and dumb
      // HTTP paths before touching the database or invoking git.
      if (!isAllowedGitPath(request.method, subPath, request.url)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      // wrap all pre-hijack DB/FS work in a local try/catch so that transient
      // errors do not propagate to the global error handler, which would log
      // request.url (containing the raw share token).
      let ctx: ServeContext | null;
      try {
        ctx = await buildShareLinkServeContext(token);
      } catch (err) {
        logger.error(
          { err },
          "skill-marketplace: error preparing git response",
        );
        return reply.code(502).send({ error: "Service unavailable" });
      }

      if (!ctx) {
        // 404 not 401: do not leak whether the token existed but was revoked
        return reply.code(404).send({ error: "Not found" });
      }

      return serveGitRequest({ request, reply, ctx, subPath });
    },
  });

  // The static marketplace. Same git plumbing; the caller's own credential
  // replaces the URL token and selects which repository they get.
  fastify.route({
    method: ["GET", "POST"],
    url: `${SKILL_MARKETPLACE_STATIC_PATH}/*`,
    handler: async (request, reply) => {
      const subPath = (request.params as { "*"?: string })["*"] ?? "";

      if (!isAllowedGitPath(request.method, subPath, request.url)) {
        return reply.code(403).send({ error: "Forbidden" });
      }

      let ctx: ServeContext | null;
      try {
        const resolved = await resolveMarketplaceViewer({
          authorization: request.headers.authorization,
        });
        if (resolved.status === "unauthenticated") {
          // git only prompts for credentials (and only consults the user's
          // credential helper) when the challenge header is present.
          return reply
            .code(401)
            .header("WWW-Authenticate", `Basic realm="${BASIC_AUTH_REALM}"`)
            .send({ error: "Unauthorized" });
        }
        if (resolved.status === "forbidden") {
          return reply.code(403).send({ error: "Forbidden" });
        }
        ctx = await buildStaticServeContext(resolved.viewer);
      } catch (err) {
        logger.error(
          { err },
          "skill-marketplace: error preparing static git response",
        );
        return reply.code(502).send({ error: "Service unavailable" });
      }

      if (!ctx) {
        // nothing this viewer may install — same answer as an unknown repo
        return reply.code(404).send({ error: "Not found" });
      }

      return serveGitRequest({ request, reply, ctx, subPath });
    },
  });
};

export default skillMarketplacePublicRoutes;

// ===== Internal helpers =====

function extractQueryString(url: string): string {
  const idx = url.indexOf("?");
  return idx === -1 ? "" : url.slice(idx + 1);
}

function pickGitProtocol(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/** Allow only the two smart-HTTP upload-pack paths; block receive-pack and dumb HTTP. */
function isAllowedGitPath(
  method: string,
  subPath: string,
  url: string,
): boolean {
  if (method === "GET") {
    if (subPath !== "info/refs") return false;
    const qs = extractQueryString(url);
    return new URLSearchParams(qs).get("service") === "git-upload-pack";
  }
  if (method === "POST") {
    return subPath === "git-upload-pack";
  }
  return false;
}

interface ServeContext {
  repoPath: string;
  /** CGI REMOTE_USER stamped on the git request, for the git-side access log. */
  remoteUser: string;
  /** Non-secret fields describing who is being served, for the access log. */
  logContext: Record<string, unknown>;
}

/** Pipe one git smart-HTTP request at an already-materialized repository. */
async function serveGitRequest(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  ctx: ServeContext;
  subPath: string;
}): Promise<void> {
  const { request, reply, ctx, subPath } = params;

  logger.info(
    {
      ...ctx.logContext,
      transport: "git-clone",
      method: request.method,
      subPath,
    },
    "skill-marketplace: serving git request",
  );

  reply.hijack();
  try {
    await serveGitHttpRequest({
      projectRoot: path.dirname(ctx.repoPath),
      pathInfo: `/${path.basename(ctx.repoPath)}/${subPath}`,
      queryString: extractQueryString(request.url),
      requestMethod: request.method,
      contentType: request.headers["content-type"],
      contentLength: request.headers["content-length"],
      gitProtocol: pickGitProtocol(request.headers["git-protocol"]),
      remoteUser: ctx.remoteUser,
      gitBinaryPath: config.git.binaryPath,
      req: request.raw as IncomingMessage,
      res: reply.raw as ServerResponse,
    });
  } catch (err) {
    logger.error(
      { err, ...ctx.logContext },
      "skill-marketplace: serveGitHttpRequest threw after hijack",
    );
    if (!(reply.raw as ServerResponse).headersSent) {
      (reply.raw as ServerResponse).writeHead(502, {
        "content-type": "text/plain",
      });
    }
    if (!(reply.raw as ServerResponse).writableEnded) {
      (reply.raw as ServerResponse).end();
    }
  }
}

/** Resolve a raw share token to the materialized repo path and safe log context. */
async function buildShareLinkServeContext(
  token: string,
  retryOnConflict = true,
): Promise<ServeContext | null> {
  const validated = await SkillShareLinkModel.validate({ rawToken: token });
  if (!validated) return null;

  const parsedPluginPlatform = PluginPlatformSchema.safeParse(
    validated.link.pluginPlatform,
  );
  const [skills, plugins, organization] = await Promise.all([
    loadSkillsForLink(validated.skills.map((s) => s.id)),
    loadPluginsForLink({
      ids: validated.plugins.map((plugin) => plugin.id),
      organizationId: validated.link.organizationId,
      clientType: validated.link.pluginClientType,
      pluginPlatform: parsedPluginPlatform.success
        ? parsedPluginPlatform.data
        : null,
    }),
    OrganizationModel.getById(validated.link.organizationId),
  ]);
  if (skills.length === 0 && plugins.length === 0) return null;

  const ownerName = organization?.name ?? DEFAULT_APP_NAME;
  const ref: MarketplaceRepoRef = { kind: "link", id: validated.link.id };

  const materializer = marketplaceMaterializer.get();
  let result: Awaited<ReturnType<typeof materializer.materialize>>;
  try {
    result = await materializer.materialize({
      ref,
      marketplaceName: validated.link.marketplaceName,
      ownerName,
      displayName:
        skills.length > 0 ? `${ownerName} Skills` : `${ownerName} Plugins`,
      skills,
      plugins,
    });
  } catch (error) {
    if (
      retryOnConflict &&
      error instanceof MarketplaceMaterializationConflictError
    ) {
      return buildShareLinkServeContext(token, false);
    }
    throw error;
  }

  return {
    repoPath: result.repoPath,
    remoteUser: `archestra-share-${validated.link.id}`,
    logContext: {
      shareLinkId: validated.link.id,
      skillIds: skills.map((s) => s.id),
      pluginIds: validated.plugins.map((plugin) => plugin.id),
    },
  };
}

/**
 * Resolve a viewer to their static marketplace repo, creating the row on first
 * clone. Null when the viewer can see no skills — there is nothing to install,
 * and an empty marketplace manifest is not something clients handle well.
 */
async function buildStaticServeContext(
  viewer: MarketplaceViewer,
  retryOnConflict = true,
): Promise<ServeContext | null> {
  const [skills, organization] = await Promise.all([
    loadMarketplaceSkills(viewer),
    OrganizationModel.getById(viewer.organizationId),
  ]);
  if (skills.length === 0) return null;

  const ownerName = organization?.name ?? DEFAULT_APP_NAME;
  // No reserved-name guard here (unlike share-link creation): every derived
  // name ends in `-skills`, which none of the reserved names do.
  const repo = await SkillMarketplaceRepoModel.ensureForViewer({
    organizationId: viewer.organizationId,
    userId: viewer.userId,
    marketplaceName: marketplaceNameFor({
      organizationId: viewer.organizationId,
      organization,
    }),
  });
  SkillMarketplaceRepoModel.touch(repo);

  const materializer = marketplaceMaterializer.get();
  let result: Awaited<ReturnType<typeof materializer.materialize>>;
  try {
    result = await materializer.materialize({
      ref: { kind: "repo", id: repo.id },
      marketplaceName: repo.marketplaceName,
      ownerName,
      displayName: `${ownerName} Skills`,
      skills,
    });
  } catch (error) {
    // Same race as the share-link path: another replica appended our sequence
    // with different bytes. Re-resolve once against the new head.
    if (
      retryOnConflict &&
      error instanceof MarketplaceMaterializationConflictError
    ) {
      return buildStaticServeContext(viewer, false);
    }
    throw error;
  }

  return {
    repoPath: result.repoPath,
    remoteUser: `archestra-marketplace-${repo.id}`,
    logContext: {
      marketplaceRepoId: repo.id,
      organizationId: viewer.organizationId,
      userId: viewer.userId,
      skillIds: skills.map((s) => s.id),
    },
  };
}

async function loadPluginsForLink(params: {
  ids: string[];
  organizationId: string;
  clientType: string | null;
  pluginPlatform: PluginPlatform | null;
}): Promise<MaterializePluginInput[]> {
  if (
    !config.plugins.enabled ||
    params.ids.length === 0 ||
    !params.clientType ||
    !params.pluginPlatform
  ) {
    return [];
  }
  const clientType = params.clientType;
  const pluginPlatform = params.pluginPlatform;
  const deliveryError = pluginDeliveryBudgetError(
    await PluginModel.getApprovedDeliveryStats({
      ids: params.ids,
      organizationId: params.organizationId,
    }),
  );
  if (deliveryError) throw new Error(deliveryError);
  const plugins = await PluginModel.findApprovedByIds({
    ids: params.ids,
    organizationId: params.organizationId,
  });
  return plugins
    .filter(
      (plugin) =>
        plugin.clientType === clientType &&
        plugin.supportedPlatforms.includes(pluginPlatform),
    )
    .map((plugin) => ({
      pluginSlug: plugin.pluginSlug,
      displayName: plugin.displayName,
      description: plugin.description,
      clientType: plugin.clientType,
      files: plugin.files.map(({ path, content, encoding, mode }) => ({
        path,
        content,
        encoding,
        mode,
      })),
    }));
}

async function loadSkillsForLink(
  skillIds: string[],
): Promise<MaterializeSkillInput[]> {
  if (skillIds.length === 0) return [];

  const [skills, filesBySkill] = await Promise.all([
    SkillModel.findByIds(skillIds),
    SkillFileModel.findBySkillIds(skillIds),
  ]);

  const skillMap = new Map(skills.map((s) => [s.id, s]));
  const results: MaterializeSkillInput[] = [];

  for (const id of skillIds) {
    const skill = skillMap.get(id);
    if (!skill) continue; // skill was deleted after link was created
    results.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      license: skill.license ?? null,
      compatibility: skill.compatibility ?? null,
      allowedTools: skill.allowedTools ?? null,
      agentName: skill.agentName ?? null,
      templated: skill.templated ?? false,
      metadata: (skill.metadata ?? {}) as Record<string, string>,
      updatedAt: skill.updatedAt,
      files: filesBySkill.get(id) ?? [],
    });
  }
  return results;
}
