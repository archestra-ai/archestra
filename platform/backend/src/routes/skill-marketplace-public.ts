import { spawnSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import config from "@/config";
import logger from "@/logging";
import {
  OrganizationModel,
  SkillFileModel,
  SkillModel,
  SkillShareLinkModel,
} from "@/models";
import { marketplaceMaterializer } from "@/skills/marketplace";
import { serveGitHttpRequest } from "@/skills/marketplace/git-http-backend";
import type { MaterializeSkillInput } from "@/skills/marketplace/materialize";

/**
 * Public, unauthenticated git smart-HTTP endpoint that serves a per-share-link
 * marketplace repository. Auth is the URL token (validated against
 * `skill_share_link.tokenHash`); the endpoint is allowlisted in the auth
 * middleware. Misses, revocations, and expirations all return 404 (no leak).
 */

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

    // remove on-disk repos whose share links have been revoked since last boot
    const activeIds = await SkillShareLinkModel.listActiveIds();
    const removed = await marketplaceMaterializer.get().sweepOrphans(activeIds);
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
  const url = `${endpoint}/:token/repo.git/*`;
  fastify.route({
    method: ["GET", "POST"],
    url,
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
        ctx = await buildServeContext(token);
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

      logger.info(
        {
          shareLinkId: ctx.shareLinkId,
          skillIds: ctx.skillIds,
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
          remoteUser: `archestra-share-${ctx.shareLinkId}`,
          gitBinaryPath: config.git.binaryPath,
          req: request.raw as IncomingMessage,
          res: reply.raw as ServerResponse,
        });
      } catch (err) {
        logger.error(
          { err, shareLinkId: ctx.shareLinkId },
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
  shareLinkId: string;
  repoPath: string;
  skillIds: string[];
}

/** Resolve a raw share token to the materialized repo path and safe log context. */
async function buildServeContext(token: string): Promise<ServeContext | null> {
  const validated = await SkillShareLinkModel.validate({ rawToken: token });
  if (!validated) return null;

  const skills = await loadSkillsForLink(validated.skills.map((s) => s.id));
  if (skills.length === 0) return null;

  const organization = await OrganizationModel.getById(
    validated.link.organizationId,
  );
  const ownerName = organization?.name ?? "Archestra";

  const materializer = marketplaceMaterializer.get();
  const result = await materializer.materialize({
    linkId: validated.link.id,
    marketplaceName: validated.link.marketplaceName,
    ownerName,
    displayName: `${ownerName} Skills`,
    skills,
  });

  return {
    shareLinkId: validated.link.id,
    repoPath: result.repoPath,
    skillIds: skills.map((s) => s.id),
  };
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
      templated: skill.templated ?? false,
      metadata: (skill.metadata ?? {}) as Record<string, string>,
      updatedAt: skill.updatedAt,
      files: filesBySkill.get(id) ?? [],
    });
  }
  return results;
}
