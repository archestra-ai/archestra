import { TOOL_TRANSFER_CREDENTIAL_SHORT_NAME } from "@archestra/shared";
import { z } from "zod";
import { AgentModel } from "@/models";
import {
  declarePersonalRuntimeCredential,
  transferPersonalRuntimeCredential,
} from "@/services/agent-runtime/credentials";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  agentCredentialSetupUrl,
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
    value: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The credential value to transfer. OMIT IT to declare the credential without a value and get back a link the person opens to paste it themselves — the value then never enters your context. Send a value only when the person asked you to move one you already hold.",
      ),
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
  valueStored: z
    .boolean()
    .describe(
      "Whether a value is now stored. False means the credential is declared and still empty.",
    ),
  url: z
    .string()
    .nullable()
    .describe(
      "Where the person pastes the value. Null when this call already stored one.",
    ),
  availability: z
    .string()
    .describe("When a run can read the value, in plain words."),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_TRANSFER_CREDENTIAL_SHORT_NAME,
    title: "Transfer Credential",
    description:
      "Give an Agent Runtime Agent a credential, so a handed-over task can use the CLI authentication the local session was using. " +
      "PREFER THE SAFE MODE: omit `value` to declare the credential and get back a link. The person opens it and pastes the value themselves, so the secret never enters your context or this transcript. Use it whenever you would otherwise have to read a secret to pass it on. " +
      "Send a `value` only when the person deliberately handed you one to move. That mode writes the secret into your context and this client's transcript, and some clients show tool arguments in their approval prompt. It is redacted from this platform's tool-call log, not from anything before it. " +
      "Either way the credential is personal to you: it applies to every run YOU start on that Agent, and never to anyone else's runs. " +
      "Organization-wide credentials are set in Settings and are refused here. " +
      "An administrator can stop an Agent accepting a transferred value in its Agent Runtime settings. Declaring stays available, because it carries no secret. " +
      "A stored value reaches the workspace on the Agent's NEXT turn, not one already running.",
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
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        if (
          !(await ResourcePermissions.allows({
            organizationId: actor.organizationId,
            userId: actor.id,
            resource: "agent",
            scope: agent.id,
            action: "read",
          }))
        ) {
          return errorResult("Agent not found");
        }
        // SPDX-SnippetEnd

        const runtime = resolveAgentRuntime(agent);
        if (!runtime) {
          return errorResult(
            "This Agent has no Agent Runtime configured, so it has no workspace to receive a credential.",
          );
        }
        const [entry] = args.environment;

        // The gate governs storing a client-supplied secret. Declaring carries
        // none, so it stays available on an Agent where storing is turned off —
        // that Agent is exactly where the person should paste the value instead.
        // Only an explicit `false` refuses: an Agent stored before this field
        // existed has no value at all, and those must keep working.
        if (
          entry.value !== undefined &&
          runtime.allowAgentSuppliedCredentialValues === false
        ) {
          return errorResult(
            `"${agent.name}" does not accept credential values from a connected client. An administrator turned that off for this Agent in its Agent Runtime settings. Call this tool again without \`value\` to declare "${entry.key}" and get a link the person can paste it into.`,
          );
        }

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

        if (entry.value === undefined) {
          const { declarationCreated } = await declarePersonalRuntimeCredential(
            {
              runtime,
              key: entry.key,
              label: args.label,
            },
          );
          const url = agentCredentialSetupUrl(agent.id, [entry.key]);
          const availability =
            "Nothing is stored yet. A run can read it once the person saves a value, from that Agent's next turn onward.";

          return structuredSuccessResult(
            {
              key: entry.key,
              scope: "personal" as const,
              declarationCreated,
              valueStored: false,
              url,
              availability,
            },
            [
              `Declared ${entry.key} on "${agent.name}". No value is stored.`,
              `Ask the person to paste it here: ${url}`,
              "Scope: personal — whatever they save applies to every run they start on this Agent, and to no one else's runs.",
              availability,
            ].join("\n"),
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
            valueStored: true,
            url: null,
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
