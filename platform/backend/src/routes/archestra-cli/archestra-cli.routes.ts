import { createReadStream } from "node:fs";
import { RouteId } from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ARCHESTRA_CLI_DOWNLOAD_PREFIX } from "@/routes/route-paths";
import {
  INSTALL_PS1,
  INSTALL_SH,
} from "@/services/archestra-cli/install-scripts";
import {
  programTargetPattern,
  servedProgramService,
} from "@/services/archestra-cli/served-program";
import { ApiError } from "@/types";

/**
 * The `archestra` program that a user runs on their own computer, for
 * example `archestra bridge start` for the MCP bridge, and the scripts that
 * the command of the MCP bridge setup dialog runs to download and start it.
 * Public: neither the program nor the scripts are secret.
 */
const archestraCliRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Before `/:target`: a fixed path wins over a parameter in Fastify, and
  // neither name is a target.
  for (const script of INSTALL_SCRIPTS) {
    fastify.get(
      `${ARCHESTRA_CLI_DOWNLOAD_PREFIX}/${script.name}`,
      {
        schema: {
          operationId: script.operationId,
          description: script.description,
          // white-label-ok: names the `archestra` program, which keeps its name in every deployment
          tags: ["Archestra CLI"],
          // No response schema: the answer is a script, not JSON.
        },
      },
      async (_request, reply) =>
        reply
          .header("Cache-Control", "no-store")
          .header("X-Content-Type-Options", "nosniff")
          .type("text/plain; charset=utf-8")
          .send(script.text),
    );
  }

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

const INSTALL_SCRIPTS = [
  {
    name: "install.sh",
    operationId: RouteId.GetArchestraCliInstallScript,
    description:
      "The shell script that sets up the MCP bridge on macOS and Linux: it downloads the archestra program and runs archestra bridge start with its arguments.",
    text: INSTALL_SH,
  },
  {
    name: "install.ps1",
    operationId: RouteId.GetArchestraCliPowershellInstallScript,
    description:
      "The PowerShell script that sets up the MCP bridge on Windows: it downloads the archestra program and runs archestra bridge start with ARCHESTRA_URL and ARCHESTRA_SETUP_CODE.",
    text: INSTALL_PS1,
  },
] as const;

const PROGRAM_NOT_OFFERED =
  "This deployment does not offer the archestra program for this system. Ask an administrator to put it in the folder that ARCHESTRA_CLI_DIR names.";
