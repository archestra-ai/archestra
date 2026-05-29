import { trace } from "@opentelemetry/api";
import { TOOL_RUN_PYTHON_SHORT_NAME } from "@shared";
import { z } from "zod";
import { codeRuntimeService } from "@/code-runtime/code-runtime-service";
import {
  CODE_RUNTIME_LIMITS,
  CodeRuntimeError,
  type RunCodeResult,
} from "@/code-runtime/types";
import config from "@/config";
import logger from "@/logging";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";

const RunPythonArgsSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .refine(
      (code) =>
        Buffer.byteLength(code, "utf8") <= CODE_RUNTIME_LIMITS.maxCodeBytes,
      {
        message: `Code must be at most ${CODE_RUNTIME_LIMITS.maxCodeBytes} bytes.`,
      },
    )
    .describe("Complete Python 3 source to execute."),
  requirements: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .refine(
          (requirement) =>
            Buffer.byteLength(requirement, "utf8") <=
            CODE_RUNTIME_LIMITS.maxRequirementBytes,
          {
            message: `Each requirement must be at most ${CODE_RUNTIME_LIMITS.maxRequirementBytes} bytes.`,
          },
        )
        .refine((requirement) => !/[\r\n\0]/.test(requirement), {
          message: "Each requirement must be a single line.",
        }),
    )
    .max(CODE_RUNTIME_LIMITS.maxRequirements)
    .optional()
    .describe(
      "Optional Python package requirements passed as repeated `uv run --with <requirement>` arguments, for example `requests` or `pandas==2.3.3`.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Optional wall-clock limit in seconds, capped at the deployment maximum (${config.codeRuntime.timeoutSeconds}s).`,
    ),
});

const RunPythonOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  durationMs: z.number(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_RUN_PYTHON_SHORT_NAME,
    title: "Run Python",
    description:
      "Execute a short Python 3 script in a throwaway sandboxed container and return its stdout, stderr, and exit code. Script files are isolated per call; numpy, pandas, and httpx are pre-warmed, and additional packages can be requested with requirements. Network access is available; wall-clock time is limited.",
    schema: RunPythonArgsSchema,
    outputSchema: RunPythonOutputSchema,
    async handler({ args, context }) {
      if (!config.codeRuntime.enabled) {
        return errorResult("Code execution is not enabled on this deployment.");
      }

      try {
        const result = await codeRuntimeService.run({
          code: args.code,
          requirements: args.requirements,
          timeoutSeconds: args.timeout_seconds,
        });

        trace.getActiveSpan()?.setAttributes({
          "code.exit_code": result.exitCode,
          "code.duration_ms": result.durationMs,
          "code.timed_out": result.timedOut,
        });
        logger.info(
          {
            agentId: context.agentId,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
          },
          "run_python executed",
        );

        return structuredSuccessResult({ ...result }, formatRunSummary(result));
      } catch (error) {
        if (error instanceof CodeRuntimeError) {
          return errorResult(error.message);
        }
        logger.error({ err: error }, "run_python failed unexpectedly");
        return errorResult("Code execution failed due to an internal error.");
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;

// === internal helpers ===

function formatRunSummary(result: RunCodeResult): string {
  const lines = [`Exit code: ${result.exitCode} (${result.durationMs} ms)`];
  if (result.timedOut) {
    lines.push("The script was killed by the wall-clock timeout.");
  }
  lines.push("", "stdout:", result.stdout || "(empty)");
  if (result.stderr) {
    lines.push("", "stderr:", result.stderr);
  }
  if (result.truncated) {
    lines.push("", "(output was truncated)");
  }
  return lines.join("\n");
}
