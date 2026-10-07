import {
  type BatteryCredentialRequest,
  BatteryCredentialRequestSchema,
  TOOL_REQUEST_BATTERY_CREDENTIALS_SHORT_NAME,
  TOOL_TRANSFER_CREDENTIAL_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { AgentModel } from "@/models";
import { openappaBatteriesService } from "@/openappa/batteries";
import {
  declarePersonalRuntimeCredential,
  transferPersonalRuntimeCredential,
} from "@/services/agent-runtime/credentials";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import {
  createRuntimeCredentialDefinition,
  deleteRuntimeCredentialDefinition,
  getRuntimeCredentialUsage,
  listRuntimeCredentialDefinitions,
  updateRuntimeCredentialDefinition,
} from "@/services/agent-runtime/runtime-credentials";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  InsertRuntimeCredentialDefinitionSchema,
  UpdateRuntimeCredentialDefinitionSchema,
} from "@/types";
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
    shortName: "list_runtime_credentials",
    title: "List credentials",
    description:
      "List reusable credential definitions visible to the caller, including whether a personal or organization connection is configured. Returns metadata only, never secret values. Use this before choosing a GitHub App for OpenAPPA sync.",
    schema: z.strictObject({}),
    async handler({ context }) {
      const actor = requireActor(context);
      const definitions = await listRuntimeCredentialDefinitions({
        organizationId: actor.organizationId,
        userId: actor.id,
      });
      return structuredSuccessResult({
        credentials: definitions.map(credentialSummary),
      });
    },
  }),
  defineArchestraTool({
    shortName: "get_runtime_credential",
    title: "Get credential",
    description:
      "Read one reusable credential definition and its usage. Never returns the secret value.",
    schema: z.strictObject({ key: z.string() }),
    async handler({ args, context }) {
      const actor = requireActor(context);
      const definition = (
        await listRuntimeCredentialDefinitions({
          organizationId: actor.organizationId,
          userId: actor.id,
        })
      ).find((item) => item.key === args.key);
      if (!definition) return errorResult("Credential not found");
      const usage = await getRuntimeCredentialUsage({
        organizationId: actor.organizationId,
        key: args.key,
      });
      return structuredSuccessResult({
        ...credentialSummary(definition),
        usage,
      });
    },
  }),
  defineArchestraTool({
    shortName: "create_runtime_credential",
    title: "Create credential definition",
    description:
      "Create credential metadata. Never request a secret in tool arguments. After creating a GitHub App definition, direct the person to connect its private key in the native credential dialog.",
    schema: InsertRuntimeCredentialDefinitionSchema,
    async handler({ args, context }) {
      const actor = requireActor(context);
      try {
        const created = await createRuntimeCredentialDefinition({
          organizationId: actor.organizationId,
          userId: actor.id,
          definition: args,
        });
        return structuredSuccessResult({
          key: created.key,
          id: created.id,
          name: created.name,
        });
      } catch (error) {
        return catchError(error, "creating the credential");
      }
    },
  }),
  defineArchestraTool({
    shortName: "update_runtime_credential",
    title: "Update credential definition",
    description:
      "Update metadata for an existing credential. This does not set a secret value.",
    schema: z.strictObject({
      key: z.string(),
      changes: UpdateRuntimeCredentialDefinitionSchema,
    }),
    async handler({ args, context }) {
      const actor = requireActor(context);
      try {
        const updated = await updateRuntimeCredentialDefinition({
          organizationId: actor.organizationId,
          key: args.key,
          definition: args.changes,
        });
        return structuredSuccessResult({
          key: updated.key,
          id: updated.id,
          name: updated.name,
        });
      } catch (error) {
        return catchError(error, "updating the credential");
      }
    },
  }),
  defineArchestraTool({
    shortName: "delete_runtime_credential",
    title: "Delete credential definition",
    description:
      "Delete an unused credential and its connection. Confirm the user's intent before calling this tool.",
    schema: z.strictObject({ key: z.string() }),
    async handler({ args, context }) {
      const actor = requireActor(context);
      try {
        await deleteRuntimeCredentialDefinition({
          organizationId: actor.organizationId,
          key: args.key,
        });
        return structuredSuccessResult({ deleted: args.key });
      } catch (error) {
        return catchError(error, "deleting the credential");
      }
    },
  }),
  defineArchestraTool({
    shortName: "request_runtime_credential_setup",
    title: "Open credential setup",
    description:
      "Ask the person to create and connect a GitHub App through the native chat dialog. Use when no suitable organization GitHub App credential exists. Secrets stay outside the conversation. In clients without this native dialog, direct the person to Settings → Credentials.",
    schema: z.strictObject({ kind: z.literal("github_app") }),
    async handler() {
      return structuredSuccessResult({
        action: "open_credential_dialog",
        kind: "github_app",
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_REQUEST_BATTERY_CREDENTIALS_SHORT_NAME,
    title: "Open battery credentials",
    description:
      'Show the person one card in Archestra chat for the tokens these batteries need: what each battery adds, how to make its token, and a picker of the organization\'s credentials with an option to add a new one or skip. Pass every battery that needs a step in one call, by the names list_guardrails_battery_fits returns. This returns at once. The person answers with a message that starts with "Battery credentials:" and names the credential key for each variable, or says it was skipped. Secrets stay outside the conversation.',
    schema: z.strictObject({
      batteries: z
        .array(z.string().min(1))
        .min(1)
        .describe("The battery names, e.g. slack or github."),
    }),
    outputSchema: BatteryCredentialRequestSchema,
    async handler({ args, context }) {
      const actor = requireActor(context);
      const setups = await openappaBatteriesService.batterySetups(
        actor.organizationId,
      );
      const names = [...new Set(args.batteries)];
      const unknown = names.filter((name) => !setups.has(name));
      if (unknown.length > 0)
        return errorResult(
          `No battery is named ${unknown.join(", ")}. Use the names list_guardrails_battery_fits returns.`,
        );
      const request: BatteryCredentialRequest = {
        batteries: names.flatMap((name) => {
          const setup = setups.get(name);
          return setup ? [{ name, title: batteryTitle(name), ...setup }] : [];
        }),
      };
      return structuredSuccessResult(
        request,
        `Opened the credential card for ${request.batteries.map((battery) => battery.title).join(", ")}. Wait for the person's "Battery credentials: ..." reply.`,
      );
    },
  }),
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

function credentialSummary(
  definition: Awaited<
    ReturnType<typeof listRuntimeCredentialDefinitions>
  >[number],
) {
  const { icon: _icon, ...summary } = definition;
  return summary;
}

function batteryTitle(name: string): string {
  if (name === "github") return "GitHub";
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
