import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import config from "@/config";
import {
  getServerRules,
  getServerRulesChangeStatus,
  previewServerRulesChange,
  proposeServerRulesChange,
} from "@/services/openappa-server-rules";
import { ApiError, UuidIdSchema } from "@/types";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

/**
 * The tools an MCP server's editors use, through the APPA Keeper, to change
 * that server's Guardrails rules. Each change is a pull request on the policy
 * repository; who may propose one is the registry's edit rule for the server,
 * checked in the service, so none of them needs a Guardrails permission.
 */

const ServerSchema = UuidIdSchema.describe(
  "The MCP server's catalog ID, as the MCP registry shows it.",
);

const FileSchema = z
  .string()
  .max(256 * 1024)
  .describe(
    "The complete file: `[policy]` with `version = 2`, then [[policy.tool]] rules for tools that carry the file's tool prefix only and any [[policy.annotator]] they use, named <tool prefix>.<name>.",
  );

const ExpectedCommitSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .describe("`expectedCommit` from get_guardrails_server_rules.");

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: "get_guardrails_server_rules",
    title: "Read an MCP server's Guardrails rules",
    annotations: { readOnlyHint: true },
    description:
      "Read one MCP server's own Guardrails rules: its file in the Git sync policy repository's self-service folder (`path`, e.g. mcp/<tool prefix>.toml), as merged at the accepted commit, or null when it has none yet (then `starter` is a first version that names every tool, to write the file from), whether appa.toml includes it (by name or through mcp/*.toml), the server's tools, every rule the policy keeps for those tools wherever it keeps it (`rules`: each with the file it comes from, the root's first since they win, then each included file, the server's own among them), the names of the root's own (`rootRules`), and the organization's authorities and sanitizers the file can use but not declare (`organizationHelpers`: names, tags and permits). A file governs every MCP server whose tools carry its prefix: `sharedWith` lists the other servers the caller may see, and `hiddenCopies` counts members' personal copies they cannot. Anyone who may open the server in the MCP registry may read them; `canEdit` says whether the caller may propose a change, which takes edit access in the registry to each shared server that owns the file (members' personal copies only follow it), not a Guardrails permission. Use this, not get_guardrails_policy, when the user asks to change one server's rules.",
    schema: z.strictObject({ mcpServerId: ServerSchema }),
    handler: ({ args, context }) =>
      answered(async () => {
        const caller = callerOf(context);
        return result(
          await getServerRules({ ...caller, catalogId: args.mcpServerId }),
        );
      }),
  }),
  defineArchestraTool({
    shortName: "preview_guardrails_server_rules_change",
    title: "Preview an MCP server's Guardrails rules change",
    annotations: { readOnlyHint: true },
    description:
      "Check a proposed rules file for one MCP server and return its `diff`, plus `rootChange` when appa.toml does not include the self-service folder yet and gains its `<folder>/*.toml` entry, once for every server. The whole organization policy is validated with the file folded in, as Git sync will compose it after the merge. This saves and opens nothing. Pass the complete file and `expectedCommit` from get_guardrails_server_rules. Rules may name only tools that carry the file's tool prefix, or all of them as `<tool prefix>__*` (each tool the file has no rule of its own for), annotators are named `<tool prefix>.<name>`, and the file declares no authority or sanitizer: it reaches the organization's through an attention mark an authority permits, or a tag, and a tool_output sanitizer also needs the tool under [policy.deployment] confined_results. Git sync refuses any other file, whoever merged it. Root rules for the same tool keep priority. Explain what the change does to agents, then ask the user before proposing it.",
    schema: z.strictObject({
      mcpServerId: ServerSchema,
      content: FileSchema,
      expectedCommit: ExpectedCommitSchema,
    }),
    handler: ({ args, context }) =>
      answered(async () => {
        const caller = callerOf(context);
        return changeResult(
          await previewServerRulesChange({
            ...caller,
            catalogId: args.mcpServerId,
            content: args.content,
            expectedCommit: args.expectedCommit,
          }),
        );
      }),
  }),
  defineArchestraTool({
    shortName: "propose_guardrails_server_rules_change",
    title: "Propose an MCP server's Guardrails rules change",
    description: `Open a pull request on the policy repository that changes one MCP server's rules file, which governs every server whose tools carry its prefix, and adds the self-service folder's \`<folder>/*.toml\` entry to appa.toml's include list when no server file is included yet. Call preview_guardrails_server_rules_change first with the same content and expectedCommit, and only after the user agreed. Nothing applies until the request is merged and Git sync pulls it. Its ${config.openappa.policyCheckName} check verifies the policy and that the user may edit each shared server that owns the file, so the user's own merge is enough; no one else's approval is needed. Give the user the link from \`url\`.`,
    schema: z.strictObject({
      mcpServerId: ServerSchema,
      content: FileSchema,
      expectedCommit: ExpectedCommitSchema,
      summary: z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .describe(
          "What the change does and why, in plain words, for the reviewers.",
        ),
    }),
    handler: ({ args, context }) =>
      answered(async () => {
        const caller = callerOf(context);
        return changeResult(
          await proposeServerRulesChange({
            ...caller,
            catalogId: args.mcpServerId,
            content: args.content,
            expectedCommit: args.expectedCommit,
            summary: args.summary,
          }),
        );
      }),
  }),
  defineArchestraTool({
    shortName: "get_guardrails_server_rules_change_status",
    title: "Check an MCP server's Guardrails rules pull request",
    annotations: { readOnlyHint: true },
    description:
      "Check a pull request propose_guardrails_server_rules_change opened for this server: `state` (open, merged or closed) and `applied`, whether Git sync has pulled the merge, so new calls follow it. A merged request not yet applied queues a sync.",
    schema: z.strictObject({
      mcpServerId: ServerSchema,
      number: z.number().int().positive(),
    }),
    handler: ({ args, context }) =>
      answered(async () => {
        const caller = callerOf(context);
        return result(
          await getServerRulesChangeStatus({
            ...caller,
            catalogId: args.mcpServerId,
            number: args.number,
          }),
        );
      }),
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
export const toolShortNames = registry.toolShortNames;

function callerOf(context: ArchestraContext) {
  const { organizationId, userId } = context;
  if (!organizationId || !userId)
    throw new ApiError(401, "Organization and user context are required");
  return { organizationId, userId };
}

function result(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: { ...value },
  };
}

/** The model reads the diff; the full texts stay in structuredContent. */
function changeResult(
  value: { before: string; after: string } & Record<string, unknown>,
): CallToolResult {
  const { before: _before, after: _after, ...rest } = value;
  return {
    content: [{ type: "text", text: JSON.stringify(rest) }],
    structuredContent: { ...value },
  };
}

/**
 * A refusal the caller can act on (no access, a stale read, a file out of
 * scope) goes back as a tool result to explain; a thrown error would read as
 * a provider failure in the chat.
 */
async function answered(
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.statusCode < 500)
      return errorResult(error.message);
    throw error;
  }
}
