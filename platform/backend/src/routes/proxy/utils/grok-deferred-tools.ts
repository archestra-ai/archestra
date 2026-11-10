import {
  PROXY_STAMPED_TOOL_ARGUMENTS,
  TOOL_ASK_USER_SHORT_NAME,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
  TOOL_RUN_TOOL_SHORT_NAME,
  TOOL_SEARCH_TOOLS_SHORT_NAME,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import {
  takeLeadingAttestation,
  verifyToolAttestation,
} from "@/archestra-mcp-server/tool-attestation";
import { declaredToolEntries, responsesItems } from "@/openappa/wire";
import type { GrokDeferredToolRecovery } from "@/proxy/plugins/appa-plugin-archestra/types";
import {
  grokCatalogToolHint,
  grokToolName,
} from "@/routes/mcp-gateway/grok-tool-names";
import { ApiError } from "@/types/api";
import { asRecord } from "@/utils/as-record";
import type { AccumulatedToolCall } from "../llm-proxy-helpers";
import {
  extractGatewayToolDeclarations,
  type GatewayToolDeclaration,
} from "./gateway-tool-declarations";
import type { GatewayToolIdentity } from "./gateway-tool-names";

export class GrokDeferredTools implements GrokDeferredToolRecovery {
  private readonly candidates: DeferredTool[];
  private readonly responsesCandidates: DeferredTool[];
  private readonly names = new Set<string>();
  private readonly canonicalNames = new Map<string, string>();
  private readonly turnQueries = new Set<string>();
  private readonly canSearch: boolean;
  private readonly recoveryTurnKnown: boolean;
  private dispatchTool?: string;
  private catalogQuery?: string;
  private readonly incompleteControls = new Set<string>();
  private remedyPairQuery?: string;

  constructor(body: unknown) {
    this.candidates = discoveryTools(body);
    this.responsesCandidates = discoveryTools(body, true);
    const record = asRecord(body);
    const key = Array.isArray(record?.input) ? "input" : "messages";
    const history = record?.[key];
    let lastPrompt = -1;
    if (Array.isArray(history)) {
      lastPrompt = history.findLastIndex(isUserPrompt);
      const turn = { ...record, [key]: history.slice(lastPrompt + 1) };
      discoveryTools(turn, key === "input", this.turnQueries);
    }
    this.recoveryTurnKnown =
      lastPrompt >= 0 || typeof record?.input === "string";
    this.canSearch = declaredToolEntries(body).some(
      ({ name, namespace }) => name === "search_tool" && !namespace,
    );
  }

  /** A lost deferred catalog may recover once in each new user turn. */
  recoverySearch(call: {
    name: string;
    arguments: string;
  }): boolean | undefined {
    if (!this.canSearch || call.name !== "search_tool") return false;
    // A delta without its user-turn boundary cannot reset a session budget.
    if (!this.recoveryTurnKnown) return undefined;
    try {
      const query = asRecord(JSON.parse(call.arguments))?.query;
      if (typeof query !== "string" || this.turnQueries.has(query))
        return false;
      this.turnQueries.add(query);
      return true;
    } catch {
      return false;
    }
  }

  prepare(params: {
    organizationId: string;
    interactionType: string;
    body: unknown;
  }): GatewayToolDeclaration[] {
    const body = asRecord(params.body);
    const responsesWire = params.interactionType.endsWith(":responses");
    if (!body || !Array.isArray(responsesWire ? body.input : body.messages))
      return [];
    const groups = new Map<string, DeferredTool[]>();
    for (const candidate of responsesWire
      ? this.responsesCandidates
      : this.candidates) {
      const group = groups.get(candidate.name) ?? [];
      group.push(candidate);
      groups.set(candidate.name, group);
    }
    const added = [];
    const messagesWire = params.interactionType === "anthropic:messages";
    for (const group of groups.values()) {
      const candidate = group[0];
      if (
        group.some(
          (entry) => JSON.stringify(entry) !== JSON.stringify(candidate),
        )
      )
        continue;
      const attestation = verifyToolAttestation({
        organizationId: params.organizationId,
        marker: candidate.marker,
      });
      if (
        !attestation ||
        (candidate.name !==
          `${candidate.server}__${attestation.advertisedName}` &&
          candidate.name !==
            `${candidate.server}__${grokToolName(attestation.advertisedName)}`) ||
        (/(?:^|__)(?:use_tool|run_tool|spawn_subagent|workflow|monitor|scheduler_create|scheduler_delete)$/.test(
          attestation.advertisedName,
        ) &&
          !(
            attestation.kind === "b" &&
            attestation.advertisedName ===
              archestraMcpBranding.getToolName(TOOL_RUN_TOOL_SHORT_NAME)
          ))
      )
        continue;
      const definition = {
        name: candidate.name,
        description: `${candidate.marker}\n${candidate.description}`,
      };
      added.push(
        messagesWire
          ? { ...definition, input_schema: candidate.schema }
          : responsesWire
            ? { type: "function", ...definition, parameters: candidate.schema }
            : {
                type: "function",
                function: { ...definition, parameters: candidate.schema },
              },
      );
      this.names.add(candidate.name);
    }
    const declarations = extractGatewayToolDeclarations({ tools: added });
    if (!Array.isArray(body.tools)) body.tools = [];
    (body.tools as unknown[]).push(...added);
    if (responsesWire) this.unwrapResponses(body.input);
    else if (Array.isArray(body.messages)) this.unwrapHistory(body.messages);
    return declarations;
  }

  /** Bind repairs only after the shared resolver has demoted conflicts. */
  bindIdentity(identity: GatewayToolIdentity): void {
    this.canonicalNames.clear();
    this.dispatchTool = undefined;
    this.catalogQuery = undefined;
    this.incompleteControls.clear();
    this.remedyPairQuery = undefined;
    for (const name of this.names) {
      const proof = identity.attestationOf(name);
      if (!proof) continue;
      const spelling = identity.spellingOf(proof.advertisedName);
      if (!spelling || spelling.namespace || !this.names.has(spelling.name))
        continue;
      this.canonicalNames.set(proof.advertisedName, spelling.name);
    }
    const control = this.canonicalNames.get(
      archestraMcpBranding.getToolName(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME),
    );
    const notice = this.canonicalNames.get(
      archestraMcpBranding.getToolName(TOOL_GET_REMEDY_PLANS_SHORT_NAME),
    );
    if (this.canSearch && (!control || !notice)) {
      for (const short of [
        TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
        TOOL_GET_REMEDY_PLANS_SHORT_NAME,
        TOOL_ASK_USER_SHORT_NAME,
      ] as const) {
        const name = this.canonicalNames.get(
          archestraMcpBranding.getToolName(short),
        );
        if (name && identity.attestationOf(name)?.kind === "b")
          this.incompleteControls.add(name);
      }
      // A signed member is evidence for discovery only. The missing member
      // still needs its own attestation and the shared same-gateway check.
      this.remedyPairQuery =
        !control && !notice
          ? `${archestraMcpBranding.serverName} remedy`
          : archestraMcpBranding
              .getToolName(
                control
                  ? TOOL_GET_REMEDY_PLANS_SHORT_NAME
                  : TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
              )
              .split("__")
              .join(" ");
    }
    const run = this.canonicalNames.get(
      archestraMcpBranding.getToolName(TOOL_RUN_TOOL_SHORT_NAME),
    );
    const search = this.canonicalNames.get(
      archestraMcpBranding.getToolName(TOOL_SEARCH_TOOLS_SHORT_NAME),
    );
    const runProof = run ? identity.attestationOf(run) : undefined;
    const searchProof = search ? identity.attestationOf(search) : undefined;
    if (
      runProof?.kind === "b" &&
      searchProof?.kind === "b" &&
      runProof.gatewayId === searchProof.gatewayId
    )
      this.dispatchTool = run;
    else if (
      this.canSearch &&
      search &&
      searchProof?.kind === "b" &&
      !identity.verified.some(
        ({ advertisedName }) =>
          advertisedName ===
          archestraMcpBranding.getToolName(TOOL_RUN_TOOL_SHORT_NAME),
      )
    ) {
      // Recover an unloaded entry point once, not a conflicting attestation.
      // The native history records the lookup, including unsuccessful results.
      const server = search.slice(0, search.lastIndexOf("__"));
      const query = `${server} run_tool search_tools`;
      if (!this.turnQueries.has(query)) this.catalogQuery = query;
    }
  }

  unwrapCalls(calls: readonly AccumulatedToolCall[]): AccumulatedToolCall[] {
    return calls.map((call) => {
      let target =
        this.target(call.name, call.arguments, call.namespace) ??
        this.repairTarget(call.name, call.arguments, call.namespace);
      if (
        target &&
        this.incompleteControls.has(target.name) &&
        this.remedyPairQuery &&
        !this.turnQueries.has(this.remedyPairQuery)
      ) {
        this.turnQueries.add(this.remedyPairQuery);
        target = {
          name: "search_tool",
          input: { query: this.remedyPairQuery, limit: 8 },
        };
      }
      return target
        ? {
            ...call,
            name: target.name,
            arguments: JSON.stringify(target.input),
          }
        : call;
    });
  }

  wrapCalls(calls: readonly AccumulatedToolCall[]): AccumulatedToolCall[] {
    return calls.map((call) => {
      if (!this.names.has(call.name)) return call;
      let input: unknown;
      try {
        input =
          typeof call.arguments === "string"
            ? JSON.parse(call.arguments)
            : call.arguments;
      } catch {
        throw new ApiError(
          503,
          "Grok gateway call has invalid authorized arguments",
        );
      }
      if (!asRecord(input) || call.namespace)
        throw new ApiError(
          503,
          "Grok gateway call cannot be represented by use_tool",
        );
      return {
        ...call,
        name: "use_tool",
        arguments: JSON.stringify({ tool_name: call.name, tool_input: input }),
      };
    });
  }

  private repairTarget(name: unknown, args: unknown, namespace?: string) {
    const input = this.nativeInput(name, args, namespace);
    if (!input) return;
    const direct = this.canonicalNames.get(input.tool_name);
    if (direct) return { name: direct, input: input.tool_input };
    const hint = grokCatalogToolHint(input.tool_name);
    const controlName =
      hint && archestraMcpBranding.isToolName(hint) ? hint : input.tool_name;
    const verified = this.canonicalNames.get(controlName);
    if (
      verified?.startsWith(
        input.tool_name.slice(0, input.tool_name.lastIndexOf("__") + 2),
      )
    )
      return { name: verified, input: input.tool_input };
    const short = archestraMcpBranding.getToolShortName(controlName);
    if (
      this.canSearch &&
      short !== null &&
      (Object.hasOwn(PROXY_STAMPED_TOOL_ARGUMENTS, short) ||
        short === TOOL_GET_REMEDY_PLANS_SHORT_NAME ||
        short === "yell")
    ) {
      // Children have their own deferred catalog. A ruling names the canonical
      // control, which is not a native MCP entry point until discovery proves
      // it. Recover by searching once; never send the control through run_tool
      // or execute its unverified name.
      const query = controlName.split("__").join(" ");
      if (!this.turnQueries.has(query))
        return { name: "search_tool", input: { query, limit: 8 } };
      return;
    }
    // search_tools returns gateway targets, not Grok catalog names. The
    // verified dispatch pair can carry that exact target and its arguments.
    // Policy still evaluates the target before this call reaches run_tool.
    if (
      (!this.dispatchTool && !this.catalogQuery) ||
      !/^[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+$/.test(input.tool_name) ||
      (short !== null &&
        (Object.hasOwn(PROXY_STAMPED_TOOL_ARGUMENTS, short) ||
          short === TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME ||
          short === TOOL_GET_REMEDY_PLANS_SHORT_NAME ||
          short === "yell")) ||
      /(?:^|__)(?:use_tool|run_tool|spawn_subagent|workflow|monitor|scheduler_create|scheduler_delete)$/.test(
        input.tool_name,
      )
    )
      return;
    if (!this.dispatchTool)
      // Only discovery runs here. The requested gateway target stays withheld.
      return {
        name: "search_tool",
        input: { query: this.catalogQuery, limit: 8 },
      };
    return {
      name: this.dispatchTool,
      input: { tool_name: input.tool_name, tool_args: input.tool_input },
    };
  }

  private target(name: unknown, args: unknown, namespace?: string) {
    const input = this.nativeInput(name, args, namespace);
    if (!input || !this.names.has(input.tool_name)) return;
    return { name: input.tool_name, input: input.tool_input };
  }

  private nativeInput(name: unknown, args: unknown, namespace?: string) {
    if (name !== "use_tool" || namespace) return;
    let input: Record<string, unknown> | undefined;
    try {
      input = asRecord(typeof args === "string" ? JSON.parse(args) : args);
    } catch {
      return;
    }
    if (
      !input ||
      Object.keys(input).some(
        (key) => !["tool_name", "tool_input"].includes(key),
      ) ||
      typeof input.tool_name !== "string" ||
      !asRecord(input.tool_input)
    )
      return;
    return {
      tool_name: input.tool_name,
      tool_input: input.tool_input as Record<string, unknown>,
    };
  }

  private unwrapResponses(input: unknown) {
    if (!Array.isArray(input)) return;
    for (const item of input) {
      const record = asRecord(item);
      if (record?.type !== "function_call" || record.namespace !== undefined)
        continue;
      const target = this.target(record.name, record.arguments);
      if (!target) continue;
      record.name = target.name;
      record.arguments = JSON.stringify(target.input);
    }
  }

  private unwrapHistory(messages: unknown[]) {
    for (const message of Array.isArray(messages) ? messages : []) {
      const record = asRecord(message);
      if (record?.role !== "assistant") continue;
      for (const call of Array.isArray(record.tool_calls)
        ? record.tool_calls
        : []) {
        const definition = asRecord(asRecord(call)?.function);
        const target = this.target(definition?.name, definition?.arguments);
        if (definition && target) {
          definition.name = target.name;
          definition.arguments = JSON.stringify(target.input);
        }
      }
      for (const block of Array.isArray(record.content) ? record.content : []) {
        const definition = asRecord(block);
        if (definition?.type !== "tool_use") continue;
        const target = this.target(definition.name, definition.input);
        if (target) {
          definition.name = target.name;
          definition.input = target.input;
        }
      }
    }
  }
}

type DeferredTool = {
  name: string;
  server: string;
  marker: string;
  description: string;
  schema: Record<string, unknown>;
};

function isUserPrompt(item: unknown): boolean {
  const record = asRecord(item);
  if (record?.role !== "user") return false;
  const content = record.content;
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((part) => {
            const block = asRecord(part);
            return ["text", "input_text"].includes(String(block?.type)) &&
              typeof block?.text === "string"
              ? [block.text]
              : [];
          })
        : [];
  // Tool-result turns and native connection/completion reminders cannot
  // replenish the recovery budget.
  return texts.some(
    (text) =>
      text.trim() !== "" &&
      !/^<system-reminder>[\s\S]*<\/system-reminder>$/.test(text.trim()),
  );
}

function discoveryTools(
  body: unknown,
  responses = false,
  queries?: Set<string>,
): DeferredTool[] {
  const record = asRecord(body);
  const messages = record?.messages;
  const searches = new Set<string>();
  const found: DeferredTool[] = [];
  if (responses) {
    collectResponsesDiscovery(record?.input, searches, found, queries);
    return found;
  }
  if (!Array.isArray(messages)) return [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const record = asRecord(message);
    if (record?.role === "assistant") {
      for (const call of Array.isArray(record.tool_calls)
        ? record.tool_calls
        : []) {
        const entry = asRecord(call);
        if (
          asRecord(entry?.function)?.name === "search_tool" &&
          typeof entry?.id === "string"
        ) {
          searches.add(entry.id);
          recordSearchQuery(asRecord(entry.function)?.arguments, queries);
        }
      }
      for (const block of Array.isArray(record.content) ? record.content : []) {
        const entry = asRecord(block);
        if (
          entry?.type === "tool_use" &&
          entry.name === "search_tool" &&
          typeof entry.id === "string"
        ) {
          searches.add(entry.id);
          recordSearchQuery(entry.input, queries);
        }
      }
    }
    const results =
      record?.role === "tool"
        ? [{ id: record.tool_call_id, content: record.content }]
        : record?.role === "user" && Array.isArray(record.content)
          ? record.content.flatMap((block) => {
              const entry = asRecord(block);
              return entry?.type === "tool_result" && !entry.is_error
                ? [{ id: entry.tool_use_id, content: entry.content }]
                : [];
            })
          : [];
    for (const result of results) {
      if (typeof result.id !== "string" || !searches.has(result.id)) continue;
      const text =
        typeof result.content === "string"
          ? result.content
          : Array.isArray(result.content)
            ? result.content
                .map((block) => asRecord(block)?.text ?? "")
                .join("")
            : "";
      collectDiscoveryText(text, found);
    }
  }
  return found;
}

function collectResponsesDiscovery(
  input: unknown,
  searches: Set<string>,
  found: DeferredTool[],
  queries?: Set<string>,
) {
  for (const item of responsesItems({ input })) {
    if (
      item.type === "function_call" &&
      item.name === "search_tool" &&
      item.namespace === undefined &&
      typeof item.call_id === "string"
    ) {
      searches.add(item.call_id);
      recordSearchQuery(item.arguments, queries);
    }
    if (
      (item.type !== "function_call_output" &&
        item.type !== "custom_tool_call_output") ||
      typeof item.call_id !== "string" ||
      !searches.has(item.call_id)
    )
      continue;
    collectDiscoveryText(outputText(item.output), found);
  }
}

function recordSearchQuery(args: unknown, queries?: Set<string>) {
  if (!queries) return;
  try {
    const input = asRecord(typeof args === "string" ? JSON.parse(args) : args);
    if (typeof input?.query === "string") queries.add(input.query);
  } catch {
    // Malformed calls supply no discovery evidence.
  }
}

function collectDiscoveryText(text: string, found: DeferredTool[]) {
  if (text.length === 0 || text.length > 1024 * 1024) return;
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asRecord(JSON.parse(text));
  } catch {
    return;
  }
  if (!Array.isArray(parsed?.results)) return;
  for (const group of parsed.results) {
    const server = asRecord(group);
    if (typeof server?.server !== "string" || !Array.isArray(server.tools))
      continue;
    for (const tool of server.tools) {
      const entry = asRecord(tool);
      if (
        typeof entry?.tool_name !== "string" ||
        typeof entry.description !== "string" ||
        !asRecord(entry.input_schema) ||
        entry.tool_name.length > 512
      )
        continue;
      const { marker, rest } = takeLeadingAttestation(entry.description);
      if (marker && found.length < 256)
        found.push({
          name: entry.tool_name,
          server: server.server,
          marker,
          description: rest,
          schema: entry.input_schema as Record<string, unknown>,
        });
    }
  }
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .map((part) => {
      const record = asRecord(part);
      return record &&
        ["text", "input_text", "output_text"].includes(String(record.type)) &&
        typeof record.text === "string"
        ? record.text
        : "";
    })
    .join("");
}
