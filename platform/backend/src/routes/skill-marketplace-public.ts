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

      const validated = await SkillShareLinkModel.validate({ rawToken: token });
      if (!validated) {
        // 404 not 401: do not leak whether the token existed but was revoked
        return reply.code(404).send({ error: "Not found" });
      }

      const skills = await loadSkillsForLink(validated.skills.map((s) => s.id));
      if (skills.length === 0) {
        return reply.code(404).send({ error: "Not found" });
      }

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

      logger.info(
        {
          shareLinkId: validated.link.id,
          skillIds: skills.map((s) => s.id),
          transport: "git-clone",
          method: request.method,
          subPath,
        },
        "skill-marketplace: serving git request",
      );

      reply.hijack();
      try {
        await serveGitHttpRequest({
          projectRoot: path.dirname(result.repoPath),
          pathInfo: `/${path.basename(result.repoPath)}/${subPath}`,
          queryString: extractQueryString(request.url),
          requestMethod: request.method,
          contentType: request.headers["content-type"],
          remoteUser: `archestra-share-${validated.link.id}`,
          gitBinaryPath: config.git.binaryPath,
          req: request.raw as IncomingMessage,
          res: reply.raw as ServerResponse,
        });
      } catch (err) {
        logger.error(
          { err, shareLinkId: validated.link.id },
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

async function loadSkillsForLink(
  skillIds: string[],
): Promise<MaterializeSkillInput[]> {
  const out: MaterializeSkillInput[] = [];
  for (const id of skillIds) {
    const skill = await SkillModel.findById(id);
    if (!skill) continue;
    const files = await SkillFileModel.findBySkillId(id);
    out.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      license: skill.license ?? null,
      compatibility: skill.compatibility ?? null,
      metadata: (skill.metadata ?? {}) as Record<string, string>,
      updatedAt: skill.updatedAt,
      files,
    });
  }
  return out;
}
