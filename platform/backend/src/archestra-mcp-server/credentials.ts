import { TOOL_TRANSFER_CREDENTIAL_SHORT_NAME } from "@archestra/shared";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import { AgentModel, AgentTeamModel } from "@/models";
import { transferPersonalRuntimeCredential } from "@/services/agent-runtime/credentials";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import { requireActor } from "./tasks";

/**
 * The secret-bearing argument reuses the catalog tools' `environment` shape on
 * purpose: `redactCatalogToolArguments` keys off `environment[].type === "secret"`,
 * so the value is replaced with a placeholder before the tool-call row is written.
 * Changing the shape here silently un-redacts the log.
 */
const TransferCredentialEnvVarSchema = z
  .object({
    key: z
      .string()
      .describe("Environment variable name, e.g. AWS_SECRET_ACCESS_KEY."),
    type: z
      .literal("secret")
      .describe("Always 'secret'. Marks the value for redaction in logs."),
    value: z.string().min(1).describe("The credential value to transfer."),
  })
  .strict();

const TransferCredentialOutputSchema = z.object({
  key: z
    .string()
    .describe("The environment variable the value is stored under."),
  scope: z
    .literal("personal")
    .describe("Who the value applies to. Always personal to the calling user."),
  declarationCreated: z
    .boolean()
    .describe("Whether this call declared the credential on the Agent."),
  availability: z
    .string()
    .describe("When a run can read the value, in plain words."),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_TRANSFER_CREDENTIAL_SHORT_NAME,
    title: "Transfer Credential",
    description:
      "Give an Agent Runtime Agent a credential this client already holds, so a handed-over task can use the CLI authentication the local session was using. " +
      "The value is stored personally for you: it applies to every run YOU start on that Agent, not only the current one, and never to anyone else's runs. " +
      "Organization-wide credentials are set in Settings and are refused here. " +
      "An Agent accepts these values unless an administrator turned that off in its Agent Runtime settings, in which case this tool refuses and the credential is set in Settings instead. " +
      "EXPOSURE: the value passes through your context and is written into this client's transcript, and some clients show tool arguments in their approval prompt. It is redacted from this platform's tool-call log, not from anything before it. Prefer Settings for a credential that should never enter a model's context. " +
      "The value reaches the workspace on the Agent's NEXT turn, not one already running.",
    schema: z.object({
      agent_id: z.string().describe("The Agent to give the credential to."),
      environment: z
        .array(TransferCredentialEnvVarSchema)
        .min(1)
        .max(1)
        .describe(
          "Exactly one credential to transfer. Never include more than the task needs.",
        ),
      label: z
        .string()
        .max(200)
        .optional()
        .describe(
          "Human-readable name shown in the Agent's credential list. Defaults to the key.",
        ),
    }),
    outputSchema: TransferCredentialOutputSchema,
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const agent = await AgentModel.findById(args.agent_id);
        if (!agent || agent.organizationId !== actor.organizationId) {
          return errorResult("Agent not found");
        }
        const isAgentAdmin = await userHasPermission(
          actor.id,
          actor.organizationId,
          "agent",
          "admin",
        );
        if (
          !(await AgentTeamModel.userHasAgentAccess(
            actor.id,
            agent.id,
            isAgentAdmin,
            agent,
          ))
        ) {
          return errorResult("Agent not found");
        }

        const runtime = resolveAgentRuntime(agent);
        if (!runtime) {
          return errorResult(
            "This Agent has no Agent Runtime configured, so it has no workspace to receive a credential.",
          );
        }
        // Only an explicit `false` refuses. An Agent stored before this field
        // existed has no value at all, and those must keep working.
        if (runtime.allowAgentSuppliedCredentialValues === false) {
          return errorResult(
            `"${agent.name}" does not accept credential values from a connected client. An administrator turned that off for this Agent in its Agent Runtime settings; set the credential in Settings instead.`,
          );
        }

        const [entry] = args.environment;
        // Checked here as well as in the service so the caller gets the real
        // reason: `catchError` deliberately flattens thrown errors to a generic
        // message, which would hide why the transfer was refused.
        const declared = runtime.credentials?.find(
          ({ key }) => key === entry.key,
        );
        if (declared?.scope === "shared") {
          return errorResult(
            `"${entry.key}" is declared as a shared credential on "${agent.name}". A shared value applies to every user's runs of this Agent, so it is set in Settings rather than transferred from a client.`,
          );
        }

        const { declarationCreated } = await transferPersonalRuntimeCredential({
          runtime,
          organizationId: actor.organizationId,
          userId: actor.id,
          key: entry.key,
          value: entry.value,
          label: args.label,
        });

        const availability =
          "Available to the next turn of this Agent. A run already in progress keeps the environment it started with, so steer or continue the run to use it.";

        return structuredSuccessResult(
          {
            key: entry.key,
            scope: "personal" as const,
            declarationCreated,
            availability,
          },
          [
            `Stored ${entry.key} for you on "${agent.name}".`,
            "Scope: personal — it applies to every run you start on this Agent, and to no one else's runs.",
            availability,
          ].join("\n"),
        );
      } catch (error) {
        return catchError(error, "transferring the credential");
      }
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
