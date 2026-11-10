import {
  type BatteryCredentialRequest,
  BatteryCredentialRequestSchema,
  normalizeSubagentLoadBalancingConfig,
  TOOL_REQUEST_BATTERY_CREDENTIALS_SHORT_NAME,
  TOOL_TRANSFER_CREDENTIAL_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { AgentExcludedSubagentModel, AgentModel } from "@/models";
import { openappaBatteriesService } from "@/openappa/batteries";
import {
  declarePersonalRuntimeCredential,
  transferPersonalRuntimeCredential,
  validateEphemeralRuntimeCredential,
} from "@/services/agent-runtime/credentials";
import { ephemeralCredentialGrantManager } from "@/services/agent-runtime/ephemeral-credential-grants";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import {
  createRuntimeCredentialDefinition,
  deleteRuntimeCredentialDefinition,
  getRuntimeCredentialUsage,
  listRuntimeCredentialDefinitions,
  updateRuntimeCredentialDefinition,
} from "@/services/agent-runtime/runtime-credentials";
import { CredentialAccess } from "@/services/credential-access";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  ApiError,
  InsertRuntimeCredentialDefinitionSchema,
  UpdateRuntimeCredentialDefinitionSchema,
} from "@/types";
import { archestraMcpBranding } from "./branding";
import {
  agentCredentialSetupUrl,
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import {
  checkCallerSubagentAccess,
  requireActor,
  resolveCandidateRuntimeSubagentIds,
  resolveTargetAgentId,
} from "./tasks";

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
  urls: z
    .array(z.string())
    .optional()
    .describe(
      "All per-subagent setup links when declaring a credential across multiple subagents.",
    ),
  ephemeral: z
    .boolean()
    .optional()
    .describe(
      "True when the credential was minted as a short-lived one-time grant instead of stored in the database.",
    ),
  credential_grant_id: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe(
      "One-time credential grant handle to pass to start_agent_run when ephemeral is true.",
    ),
  expires_in_seconds: z
    .number()
    .int()
    .optional()
    .describe("Seconds until the ephemeral credential grant expires."),
  availability: z
    .string()
    .describe("When a run can read the value, in plain words."),
  next_step: z
    .string()
    .optional()
    .describe(
      "What to do with `url`: hand it over in the reply text, never inside a question form. Only set while a value is still missing.",
    ),
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
        await CredentialAccess.requireByKey({
          organizationId: actor.organizationId,
          userId: actor.id,
          key: args.key,
          action: "update",
        });
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
        return credentialError(error, "updating the credential");
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
        await CredentialAccess.requireByKey({
          organizationId: actor.organizationId,
          userId: actor.id,
          key: args.key,
          action: "delete",
        });
        await deleteRuntimeCredentialDefinition({
          organizationId: actor.organizationId,
          key: args.key,
        });
        return structuredSuccessResult({ deleted: args.key });
      } catch (error) {
        return credentialError(error, "deleting the credential");
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
    description: `Show the person one card in ${archestraMcpBranding.appName} chat for the tokens these batteries need: what each battery adds, how to make its token, and a picker of the organization's credentials with an option to add a new one or skip. Pass every battery that needs a step in one call, by the names list_guardrails_battery_fits returns. This returns at once. The person answers with a message that starts with "Battery credentials:" and names the credential key for each variable, or says it was skipped. Secrets stay outside the conversation.`,
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
      const request: BatteryCredentialRequest = { batteries: [] };
      const unknown: string[] = [];
      for (const name of new Set(args.batteries)) {
        const setup = setups.get(name);
        if (setup)
          request.batteries.push({ name, title: batteryTitle(name), ...setup });
        else unknown.push(name);
      }
      if (unknown.length > 0)
        return errorResult(
          `No battery is named ${unknown.join(", ")}. Use the names list_guardrails_battery_fits returns.`,
        );
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
      "Give a Remote Agent a credential, so a handed-over task can use the CLI authentication the local session was using. " +
      "PREFER THE SAFE MODE: omit `value` to declare the credential and get back a link. The person opens it and pastes the value themselves, so the secret never enters your context or this transcript. Use it whenever you would otherwise have to read a secret to pass it on. " +
      "Send a `value` only when the person deliberately handed you one to move. That mode writes the secret into your context and this client's transcript, and some clients show tool arguments in their approval prompt. It is redacted from this platform's tool-call log, not from anything before it. " +
      "Either way the credential is personal to you: it applies to every run YOU start on that Agent, and never to anyone else's runs. " +
      "Organization-wide credentials are set in Settings and are refused here. " +
      "An administrator can stop an Agent accepting a transferred value in its Agent Runtime settings. Declaring stays available, because it carries no secret. " +
      "A stored value reaches the workspace on the Agent's NEXT turn, not one already running.",
    schema: z.object({
      agent_id: z
        .string()
        .optional()
        .describe(
          "The Agent to give the credential to (UUID or agent__<slug> tool name). Omit when calling through an MCP gateway to transfer the credential to all runtime subagents assigned to the gateway, or pass a load-balanced router agent to target its assigned runtime subagents.",
        ),
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
      ephemeral: z
        .boolean()
        .optional()
        .describe(
          "When true, mints a short-lived one-time credential_grant_id handle instead of persisting the secret in the database or mutating subagent declarations. Pass the returned credential_grant_id to start_agent_run so the secret is bound only to the single winning subagent pod.",
        ),
      ttl_seconds: z
        .number()
        .int()
        .min(30)
        .max(3600)
        .optional()
        .describe(
          "Optional TTL in seconds (30–3600, default 300) for an ephemeral credential grant. Implies ephemeral: true.",
        ),
    }),
    outputSchema: TransferCredentialOutputSchema,
    handler: async ({ args, context }) => {
      try {
        const actor = requireActor(context);
        const rawAgentId = args.agent_id?.trim();
        const callerAgent = context.agent?.id
          ? await AgentModel.findById(context.agent.id)
          : null;
        let explicitAgentId: string | undefined;
        if (rawAgentId) {
          const resolvedId = await resolveTargetAgentId({
            agentIdOrToolName: rawAgentId,
            callerAgent,
            context,
          });
          if (!resolvedId) {
            return errorResult("Agent not found");
          }
          explicitAgentId = resolvedId;
        }

        let isRouterPoolTarget = false;
        let candidateAgentIds: string[] = [];
        if (explicitAgentId) {
          const explicitTargetAgent =
            await AgentModel.findById(explicitAgentId);
          const targetLbConfig = explicitTargetAgent
            ? normalizeSubagentLoadBalancingConfig(
                explicitTargetAgent.subagentLoadBalancing,
              )
            : undefined;
          if (
            explicitTargetAgent &&
            !resolveAgentRuntime(explicitTargetAgent) &&
            targetLbConfig?.enabled
          ) {
            if (explicitTargetAgent.organizationId !== actor.organizationId) {
              return errorResult("Agent not found");
            }
            if (
              !(await ResourcePermissions.allows({
                organizationId: actor.organizationId,
                userId: actor.id,
                resource: "agent",
                scope: explicitTargetAgent.id,
                action: "read",
              }))
            ) {
              return errorResult("Agent not found");
            }
            const subagentAccess = await checkCallerSubagentAccess(
              context.agent.id,
              explicitTargetAgent,
            );
            if (!subagentAccess.allowed) {
              return errorResult(
                subagentAccess.reason === "agent_not_found"
                  ? "Agent not found"
                  : subagentAccess.message,
              );
            }
            candidateAgentIds = await resolveCandidateRuntimeSubagentIds({
              callerAgent: explicitTargetAgent,
              actorUserId: actor.id,
            });
            if (callerAgent && callerAgent.id !== explicitTargetAgent.id) {
              const callerExcludedIds =
                await AgentExcludedSubagentModel.findTargetAgentIdsByAgent(
                  callerAgent.id,
                );
              if (callerExcludedIds.length > 0) {
                const callerExcludedSet = new Set(callerExcludedIds);
                candidateAgentIds = candidateAgentIds.filter(
                  (id) => !callerExcludedSet.has(id),
                );
              }
            }
            isRouterPoolTarget = true;
          } else {
            candidateAgentIds = [explicitAgentId];
          }
        } else if (callerAgent) {
          candidateAgentIds = await resolveCandidateRuntimeSubagentIds({
            callerAgent,
            actorUserId: actor.id,
          });
        }

        const isSingleExplicitTarget = Boolean(
          explicitAgentId && !isRouterPoolTarget,
        );
        if (!isSingleExplicitTarget && candidateAgentIds.length === 0) {
          return errorResult(
            callerAgent || isRouterPoolTarget
              ? "No runtime subagents are assigned to this gateway."
              : "agent_id is required.",
          );
        }

        const targets: {
          agent: NonNullable<Awaited<ReturnType<typeof AgentModel.findById>>>;
          runtime: NonNullable<ReturnType<typeof resolveAgentRuntime>>;
        }[] = [];

        for (const candidateId of candidateAgentIds) {
          const agent = await AgentModel.findById(candidateId);
          if (!agent || agent.organizationId !== actor.organizationId) {
            if (isSingleExplicitTarget) return errorResult("Agent not found");
            continue;
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
            if (isSingleExplicitTarget) return errorResult("Agent not found");
            continue;
          }
          // SPDX-SnippetEnd
          const subagentAccess = await checkCallerSubagentAccess(
            context.agent.id,
            agent,
          );
          if (!subagentAccess.allowed) {
            if (isSingleExplicitTarget) {
              return errorResult(
                subagentAccess.reason === "agent_not_found"
                  ? "Agent not found"
                  : subagentAccess.message,
              );
            }
            continue;
          }

          const runtime = resolveAgentRuntime(agent);
          if (!runtime) {
            if (isSingleExplicitTarget) {
              return errorResult(
                "This Agent has no Agent Runtime configured, so it has no workspace to receive a credential.",
              );
            }
            continue;
          }
          targets.push({ agent, runtime });
        }

        if (targets.length === 0) {
          return errorResult("Agent not found");
        }

        const [entry] = args.environment;
        const isEphemeral =
          args.ephemeral === true || args.ttl_seconds !== undefined;

        if (isEphemeral && entry.value === undefined) {
          return errorResult(
            "Ephemeral credential grants require a `value`. Omit `ephemeral` and `ttl_seconds` to declare the credential without a value.",
          );
        }

        for (const { agent, runtime } of targets) {
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
        }

        const targetNamesLabel = targets
          .map(({ agent }) => `"${agent.name}"`)
          .join(", ");

        if (isEphemeral && entry.value !== undefined) {
          for (const { runtime } of targets) {
            await validateEphemeralRuntimeCredential({
              runtime,
              organizationId: actor.organizationId,
              userId: actor.id,
              key: entry.key,
              label: args.label,
            });
          }
          const { grantId, expiresInSeconds } =
            await ephemeralCredentialGrantManager.createGrant({
              organizationId: actor.organizationId,
              userId: actor.id,
              callerAgentId: context.agent.id,
              allowedAgentIds: targets.map(({ agent }) => agent.id),
              key: entry.key,
              value: entry.value,
              ttlSeconds: args.ttl_seconds,
            });
          const availability = `Bound to one-time grant ${grantId} (expires in ${expiresInSeconds}s). Pass credential_grant_ids: ["${grantId}"] to start_agent_run so the credential is injected only into the single winning subagent pod.`;
          return structuredSuccessResult(
            {
              key: entry.key,
              scope: "personal" as const,
              declarationCreated: false,
              valueStored: true,
              url: null,
              ephemeral: true,
              credential_grant_id: grantId,
              expires_in_seconds: expiresInSeconds,
              availability,
            },
            [
              `Minted ephemeral credential grant ${grantId} for ${entry.key} on ${targetNamesLabel}.`,
              "Scope: personal & ephemeral — never written to the database; consumed once by start_agent_run.",
              availability,
            ].join("\n"),
          );
        }

        if (entry.value === undefined) {
          let anyDeclarationCreated = false;
          const completedNames: string[] = [];
          try {
            for (const { agent, runtime } of targets) {
              const { declarationCreated } =
                await declarePersonalRuntimeCredential({
                  runtime,
                  key: entry.key,
                  label: args.label,
                });
              if (declarationCreated) anyDeclarationCreated = true;
              completedNames.push(`"${agent.name}"`);
            }
          } catch (error) {
            const response = catchError(error, "transferring the credential");
            if (
              completedNames.length > 0 &&
              response.content?.[0]?.type === "text"
            ) {
              return errorResult(
                `${response.content[0].text} (Already declared on: ${completedNames.join(", ")}.)`,
              );
            }
            return response;
          }
          const urls = targets.map(({ agent }) =>
            agentCredentialSetupUrl(agent.id, [entry.key]),
          );
          const url = urls[0];
          const availability =
            "Nothing is stored yet. A run can read it once the person saves a value, from that Agent's next turn onward.";
          // Question forms show a link as plain text, so the model must hand
          // it over in its reply. Said in both the text and the structured
          // result, since a client may show the model only one of them.
          const nextStep =
            "Put the url in your reply text, never inside a question form, so the person can paste the value there.";

          return structuredSuccessResult(
            {
              key: entry.key,
              scope: "personal" as const,
              declarationCreated: anyDeclarationCreated,
              valueStored: false,
              url,
              ...(urls.length > 1 ? { urls } : {}),
              availability,
              next_step: nextStep,
            },
            [
              `Declared ${entry.key} on ${targetNamesLabel}. No value is stored.`,
              urls.length > 1
                ? `Put these links in your reply text, never inside a question form, so the person can paste it:\n${urls.map((u, idx) => `- ${targets[idx].agent.name}: ${u}`).join("\n")}`
                : `Put this link in your reply text, never inside a question form, so the person can paste it: ${url}`,
              "Scope: personal — whatever they save applies to every run they start on this Agent, and to no one else's runs.",
              availability,
            ].join("\n"),
          );
        }

        let anyDeclarationCreated = false;
        const completedNames: string[] = [];
        try {
          for (const { agent, runtime } of targets) {
            const { declarationCreated } =
              await transferPersonalRuntimeCredential({
                runtime,
                organizationId: actor.organizationId,
                userId: actor.id,
                key: entry.key,
                value: entry.value,
                label: args.label,
              });
            if (declarationCreated) anyDeclarationCreated = true;
            completedNames.push(`"${agent.name}"`);
          }
        } catch (error) {
          const response = catchError(error, "transferring the credential");
          if (
            completedNames.length > 0 &&
            response.content?.[0]?.type === "text"
          ) {
            return errorResult(
              `${response.content[0].text} (Already stored on: ${completedNames.join(", ")}.)`,
            );
          }
          return response;
        }

        const availability =
          "Available to the next turn of this Agent. A run already in progress keeps the environment it started with, so steer or continue the run to use it.";

        return structuredSuccessResult(
          {
            key: entry.key,
            scope: "personal" as const,
            declarationCreated: anyDeclarationCreated,
            valueStored: true,
            url: null,
            availability,
          },
          [
            `Stored ${entry.key} for you on ${targetNamesLabel}.`,
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

/** A refusal names its reason; anything else stays a generic failure. */
function credentialError(error: unknown, action: string) {
  if (error instanceof ApiError && error.statusCode < 500)
    return errorResult(error.message);
  return catchError(error, action);
}
