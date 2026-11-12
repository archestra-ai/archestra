import { createReadStream } from "node:fs";
import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ARCHESTRA_CLI_DOWNLOAD_PREFIX } from "@/routes/route-paths";
import {
  programTargetPattern,
  servedProgramService,
} from "@/services/archestra-cli/served-program";
import { ApiError } from "@/types";

/**
 * The `archestra` program that a user runs on their own computer, for
 * example `archestra bridge start` for the MCP bridge. The Connect page's
 * command downloads it from here. Public: the program is not secret.
 */
const archestraCliRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    `${ARCHESTRA_CLI_DOWNLOAD_PREFIX}/:target`,
    {
      schema: {
        operationId: RouteId.DownloadArchestraCli,
        description:
          "Download the archestra program for one operating system and CPU, for example darwin-arm64, linux-x86_64 or windows-AMD64.",
        // white-label-ok: names the `archestra` program, which keeps its name in every deployment
        tags: ["Archestra CLI"],
        params: z.object({
          // As `uname -s` and `uname -m` print them ("Darwin-arm64",
          // "Linux-aarch64"), or "windows-" and PROCESSOR_ARCHITECTURE
          // ("windows-AMD64").
          target: z.string().regex(programTargetPattern()),
        }),
        // No response schema: the answer is the program file, not JSON.
      },
    },
    async (request, reply) => {
      const file = await servedProgramService.findFile(request.params.target);
      if (!file) {
        throw new ApiError(404, PROGRAM_NOT_OFFERED);
      }
      return reply
        .header("Content-Length", file.size)
        .header(
          "Content-Disposition",
          `attachment; filename="${file.downloadName}"`,
        )
        .header("X-Content-Type-Options", "nosniff")
        .type("application/octet-stream")
        .send(createReadStream(file.path));
    },
  );
};

export default archestraCliRoutes;

// === Internal helpers

const PROGRAM_NOT_OFFERED =
  "This deployment does not offer the archestra program for this system. Ask an administrator to put it in the folder that ARCHESTRA_CLI_DIR names.";
