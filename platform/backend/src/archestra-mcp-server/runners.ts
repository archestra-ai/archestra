import {
  TOOL_GET_RUNNER_SHORT_NAME,
  TOOL_LIST_RUNNERS_SHORT_NAME,
  TOOL_SEND_TO_RUNNER_SHORT_NAME,
  TOOL_START_RUNNER_SHORT_NAME,
  TOOL_STOP_RUNNER_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import { RunnerEventModel, RunnerModel } from "@/models";
import { RunnerCredentialsRequiredError } from "@/services/runners/launch-spec";
import { startRunner } from "@/services/runners/start-runner";
import type { Runner } from "@/types";
import { RunnerStateSchema } from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";

// === Constants ===

const RunnerOutputItemSchema = z.object({
  id: z.string().describe("The runner ID."),
  name: z.string().describe("The runner's display name."),
  agentId: z.string().describe("The agent this runner is running."),
  state: RunnerStateSchema.describe("Current lifecycle state."),
  statusReason: z
    .string()
    .nullable()
    .describe("Why the runner is in its current state, when known."),
  image: z.string().describe("Container image the session is running."),
  createdByUserId: z
    .string()
    .describe("The user this runner acts on behalf of."),
  createdAt: z.string().describe("When the runner was created (ISO 8601)."),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_START_RUNNER_SHORT_NAME,
    title: "Start Runner",
    description:
      "Start a long-running agent session in its own container for an agent that has runner configuration. The session runs on YOUR behalf: it uses your credentials and its LLM usage is attributed to you. Returns immediately — the session provisions in the background, so poll get_runner for its state.",
    schema: z
      .object({
        agentId: z.string().uuid().describe("ID of the agent to run."),
        name: z
          .string()
          .min(1)
          .max(200)
          .describe("Short human-readable name for this session."),
        task: z
          .string()
          .max(20_000)
          .optional()
          .describe("Initial instruction handed to the agent on start."),
      })
      .strict(),
    outputSchema: z.object({ runner: RunnerOutputItemSchema }),
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required");
      }
      if (!runnerRuntimeManager.isEnabled) {
        return errorResult("Runners are not enabled on this deployment");
      }
      try {
        {
          const runner = await startRunner({
            agentId: args.agentId,
            organizationId: context.organizationId,
            // The identity is the gateway-authenticated caller, never an
            // argument: a model must not be able to start a session as
            // someone else.
            userId: context.userId,
            name: args.name,
            task: args.task,
          });
          return structuredSuccessResult({ runner: serializeRunner(runner) });
        }
      } catch (error) {
        if (error instanceof RunnerCredentialsRequiredError) {
          // Named in the reply so the agent can tell the human exactly what to
          // add, rather than reporting an opaque failure.
          return errorResult(
            `${error.message}. Add them under Account → Credentials, then start the runner again.`,
          );
        }
        return catchError(error, "starting runner");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_LIST_RUNNERS_SHORT_NAME,
    title: "List Runners",
    description:
      "List agent sessions in the organization, optionally filtered by agent or state.",
    schema: z
      .object({
        agentId: z
          .string()
          .optional()
          .describe("Only list runners for this agent."),
        state: RunnerStateSchema.optional().describe(
          "Only list runners in this state.",
        ),
        mine: z.boolean().optional().describe("Only list runners you started."),
      })
      .strict(),
    outputSchema: z.object({ runners: z.array(RunnerOutputItemSchema) }),
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required");
      }
      try {
        const runners = await RunnerModel.list({
          organizationId: context.organizationId,
          agentId: args.agentId,
          createdByUserId: args.mine ? context.userId : undefined,
          states: args.state ? [args.state] : undefined,
        });
        return structuredSuccessResult({
          runners: runners.map(serializeRunner),
        });
      } catch (error) {
        return catchError(error, "listing runners");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_GET_RUNNER_SHORT_NAME,
    title: "Get Runner",
    description:
      "Get one agent session with its recent timeline: state changes, steer messages and lifecycle notices.",
    schema: z.object({ runnerId: z.string().uuid() }).strict(),
    outputSchema: z.object({
      runner: RunnerOutputItemSchema,
      events: z.array(
        z.object({
          sequence: z.number(),
          kind: z.string(),
          message: z.string().nullable(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required");
      }
      try {
        const runner = await RunnerModel.findById(
          args.runnerId,
          context.organizationId,
        );
        if (!runner) {
          return errorResult(`Runner ${args.runnerId} not found`);
        }
        const events = await RunnerEventModel.listForRunner(runner.id, 50);
        return structuredSuccessResult({
          runner: serializeRunner(runner),
          events: events.map((event) => ({
            sequence: event.sequence,
            kind: event.kind,
            message: event.message,
            createdAt: event.createdAt.toISOString(),
          })),
        });
      } catch (error) {
        return catchError(error, "getting runner");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_SEND_TO_RUNNER_SHORT_NAME,
    title: "Send To Runner",
    description:
      "Send a message into a live agent session. The message is delivered at a turn boundary, so it never interrupts a tool call already in flight. Only the person who started the session can steer it.",
    schema: z
      .object({
        runnerId: z.string().uuid(),
        message: z.string().min(1).max(20_000),
      })
      .strict(),
    outputSchema: z.object({ delivered: z.literal(true) }),
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required");
      }
      try {
        const runner = await RunnerModel.findById(
          args.runnerId,
          context.organizationId,
        );
        if (!runner) {
          return errorResult(`Runner ${args.runnerId} not found`);
        }
        const denial = await denyIfNotSteerable(runner, {
          userId: context.userId,
          organizationId: context.organizationId,
        });
        if (denial) return denial;
        if (runner.state !== "running") {
          return errorResult(
            `Runner ${runner.id} is ${runner.state}, so there is no live session to send to`,
          );
        }

        await runnerRuntimeManager.steer({ runner, message: args.message });
        await RunnerEventModel.append({
          runnerId: runner.id,
          kind: "steer",
          message: args.message,
          actorUserId: context.userId,
        });
        return structuredSuccessResult({ delivered: true as const });
      } catch (error) {
        return catchError(error, "sending to runner");
      }
    },
  }),

  defineArchestraTool({
    shortName: TOOL_STOP_RUNNER_SHORT_NAME,
    title: "Stop Runner",
    description:
      "Stop a live agent session and remove its container. In-memory session state is lost, so stop only when the work is finished or abandoned.",
    schema: z
      .object({
        runnerId: z.string().uuid(),
        reason: z.string().max(500).optional(),
      })
      .strict(),
    outputSchema: z.object({ runner: RunnerOutputItemSchema }),
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required");
      }
      try {
        const runner = await RunnerModel.findById(
          args.runnerId,
          context.organizationId,
        );
        if (!runner) {
          return errorResult(`Runner ${args.runnerId} not found`);
        }
        const denial = await denyIfNotSteerable(runner, {
          userId: context.userId,
          organizationId: context.organizationId,
        });
        if (denial) return denial;

        await runnerRuntimeManager.stop(
          runner,
          args.reason ?? "Stopped by request",
        );
        const stopped = await RunnerModel.findById(
          runner.id,
          context.organizationId,
        );
        return structuredSuccessResult({
          runner: serializeRunner(stopped ?? runner),
        });
      } catch (error) {
        return catchError(error, "stopping runner");
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;

// === Internal helpers ===

/**
 * Steering and stopping reach a session running under its creator's own
 * credentials, so they are restricted to that person or a runner admin —
 * deliberately narrower than the permission that exposes the tool.
 */
async function denyIfNotSteerable(
  runner: Runner,
  context: { userId: string; organizationId: string },
): Promise<ReturnType<typeof errorResult> | null> {
  if (runner.createdByUserId === context.userId) {
    return null;
  }
  const isAdmin = await userHasPermission(
    context.userId,
    context.organizationId,
    "runner",
    "admin",
  );
  return isAdmin
    ? null
    : errorResult("Only the person who started this runner can control it");
}

function serializeRunner(runner: Runner) {
  return {
    id: runner.id,
    name: runner.name,
    agentId: runner.agentId,
    state: runner.state,
    statusReason: runner.statusReason,
    image: runner.image,
    createdByUserId: runner.createdByUserId,
    createdAt: runner.createdAt.toISOString(),
  };
}
