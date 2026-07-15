import type { ArchestraToolShortName } from "@archestra/shared";
import {
  APP_ASSIGNABLE_ARCHESTRA_TOOL_SHORT_NAMES,
  ARCHESTRA_MCP_CATALOG_ID,
  isAppAssignableArchestraToolShortName,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
  TOOL_READ_FILE_SHORT_NAME,
} from "@archestra/shared";
import type { McpUiToolMeta } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import {
  AppModel,
  TeamModel,
  ToolInvocationPolicyModel,
  ToolModel,
} from "@/models";

/**
 * The App Data Store tools are the ONLY Archestra built-ins an app runtime may
 * dispatch — they run in-process keyed by the route-bound appId. Every other
 * Archestra tool (the management/chat surface) is rejected by the gate.
 */
const APP_DATA_SHORT_NAMES = new Set<string>([
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
]);

/** Reserved Archestra built-ins an app runtime may dispatch via the SDK. */
export const APP_RUNTIME_BUILTIN_SHORT_NAMES = new Set<string>([
  ...APP_DATA_SHORT_NAMES,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
]);

/**
 * The canonical availability predicate for the second, opt-in tier of
 * app-callable Archestra built-ins (the read-only file tools). One place folds
 * the shared allowlist and the feature flags together, and every consumer —
 * the runtime gate, the dispatch re-check, tools/list, the SDK bootstrap, the
 * assignment paths, `preview_app_tool`, and the tools-editor candidate route —
 * asks it, so a dark flag turns the whole surface off at once. The file tools
 * are registered only under `skillsSandbox` (see the backend
 * `getArchestraMcpTools` gate).
 */
export function isAppAssignableArchestraTool(
  shortName: string,
): shortName is ArchestraToolShortName {
  return (
    isAppAssignableArchestraToolShortName(shortName) &&
    config.skillsSandbox.enabled
  );
}

/**
 * The full (branded) tool names an app may currently be granted — empty when
 * any governing feature flag is dark. The candidate source for the app
 * tools-editor's built-in group; names go through the branding singleton so a
 * white-labeled prefix matches the seeded rows.
 */
export function getAppAssignableBuiltinFullNames(): string[] {
  return APP_ASSIGNABLE_ARCHESTRA_TOOL_SHORT_NAMES.filter((shortName) =>
    isAppAssignableArchestraTool(shortName),
  ).map((shortName) => archestraMcpBranding.getToolName(shortName));
}

/**
 * Fail-closed re-check that an app-assignable built-in is (still) granted to
 * the app: the allowlist + feature flags via the canonical predicate, and a
 * live `app_tools` row. Returns the tool's stored full name, or null. Shared by
 * the dispatch handlers (`createAppServer`, `preview_app_tool`) so an
 * assignment revoked between the route gate and execution is refused by both.
 */
export async function getAssignedAppBuiltin(
  toolName: string,
  appId: string,
): Promise<string | null> {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (!shortName || !isAppAssignableArchestraTool(shortName)) return null;
  // Filter (not first-row) by catalog: a same-named upstream tool assigned via
  // the raw-id endpoint could otherwise shadow the built-in grant depending on
  // row ordering.
  const assigned = await ToolModel.getMcpToolsAssignedToApp([toolName], appId);
  const builtin = assigned.find(
    (tool) => tool.catalogId === ARCHESTRA_MCP_CATALOG_ID,
  );
  return builtin?.toolName ?? null;
}

/**
 * Redact an app-dispatched built-in's result before it is persisted as an
 * audit row. `read_file` returns the file's contents (numbered text lines or an
 * inline image), and a read-only app operation must not create a second,
 * long-lived database copy of them — the structured metadata (filename, size,
 * line window) is kept, the content blocks are replaced. Every other built-in's
 * result passes through unchanged. Audit persistence stays best-effort; this
 * only shapes WHAT is stored, never whether the call proceeds.
 */
export function redactAppBuiltinAuditResult(
  toolName: string,
  response: CallToolResult,
): CallToolResult {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (shortName !== TOOL_READ_FILE_SHORT_NAME) return response;
  // Error results carry diagnostics (not-found, size caps), never file bytes —
  // keep them intact for the audit trail.
  if (response.isError) return response;
  // structuredContent mirrors the read window in its `content` field — strip
  // it the same way, keeping the metadata for the audit trail.
  const structured =
    response.structuredContent && typeof response.structuredContent === "object"
      ? (() => {
          const { content: _content, ...meta } =
            response.structuredContent as Record<string, unknown>;
          return meta;
        })()
      : response.structuredContent;
  return {
    ...response,
    structuredContent: structured,
    content: [
      {
        type: "text",
        text: "[file content not persisted in audit logs]",
      },
    ],
  };
}

type AppToolGateDecision =
  | { allowed: true; kind: "app-builtin" }
  | { allowed: true; kind: "upstream"; resolvedToolName: string }
  | { allowed: false; code: number; reason: string };

/**
 * The single fail-closed gate for a tool call made *as an app* — shared by the
 * app runtime proxy (every rendered-app tools/call) and `preview_app_tool` so
 * neither can diverge from the other's allowlist.
 *
 * It resolves the tool the way dispatch does (App Data Store built-ins;
 * otherwise the per-app assignment, exact name then the unprefixed-suffix
 * fallback), enforces `_meta.ui.visibility`, and then evaluates the target
 * tool's invocation policies. Owned-app runtime calls otherwise bypass the
 * policy engine entirely, so `block_always` (and matching specific blocks) are
 * enforced here. `isContextTrusted` controls the untrusted-context rules: the
 * iframe runtime passes `true` (only `block_always`/`require_approval` gate it,
 * so a no-policy tool keeps working as apps did before any enforcement), while
 * `preview_app_tool` forwards the chat's real trust so a
 * `block_when_context_is_untrusted` policy still fires on the authoring path.
 * `require_approval` is enforced by the caller: the iframe runtime has no
 * approval UI so it sets `treatRequireApprovalAsBlock`, while `preview_app_tool`
 * carries its own human-approval gate and does not.
 */
export async function gateAppToolCall(params: {
  appId: string;
  organizationId: string;
  userId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  isContextTrusted: boolean;
  treatRequireApprovalAsBlock: boolean;
}): Promise<AppToolGateDecision> {
  const { appId, userId, toolName, toolInput } = params;

  // Archestra built-ins: two tiers. The reserved app-runtime tools (App Data
  // Store + the LLM completion) are always dispatchable; the app-assignable
  // file tools additionally require a live `app_tools` grant. Both run
  // in-process and bypass invocation policy (consistent with the rest of the
  // engine — Archestra tools are trusted; RBAC still applies inside
  // executeArchestraTool).
  if (archestraMcpBranding.isToolName(toolName)) {
    const shortName = archestraMcpBranding.getToolShortName(toolName);
    if (shortName && APP_RUNTIME_BUILTIN_SHORT_NAMES.has(shortName)) {
      return { allowed: true, kind: "app-builtin" };
    }
    if (shortName && isAppAssignableArchestraTool(shortName)) {
      if (await getAssignedAppBuiltin(toolName, appId)) {
        return { allowed: true, kind: "app-builtin" };
      }
      return {
        allowed: false,
        code: -32601,
        reason: `Tool "${toolName}" is not assigned to this app.`,
      };
    }
    return {
      allowed: false,
      code: -32601,
      reason: `Tool "${toolName}" is not available to apps.`,
    };
  }

  // Resolve exactly like dispatch (clients/mcp-client.ts validateAndGetTool):
  // exact name first, then — for unprefixed names only — the suffix fallback.
  let [tool] = await ToolModel.getMcpToolsAssignedToApp([toolName], appId);
  if (!tool && !toolName.includes(MCP_SERVER_TOOL_NAME_SEPARATOR)) {
    [tool] = await ToolModel.getMcpToolsAssignedToAppBySuffix(toolName, appId);
  }
  if (!tool) {
    return {
      allowed: false,
      code: -32601,
      reason: `Tool "${toolName}" is not assigned to this app.`,
    };
  }
  // An assigned Archestra built-in reached by an unprefixed suffix would fall
  // through to the upstream dispatch path (which cannot execute it). Require
  // the full branded name, which the branch above handles in-process.
  if (tool.catalogId === ARCHESTRA_MCP_CATALOG_ID) {
    return {
      allowed: false,
      code: -32601,
      reason: `Tool "${toolName}" must be called by its full name "${tool.toolName}".`,
    };
  }

  // Environment fence: a tool whose catalog left the app's bound environment is
  // refused at call time even though its assignment row remains
  // (re-binding an app does not strip assignments). Reuses the same predicate as
  // the assignment fence so the two never diverge. Only upstream tools reach
  // here — app-runtime built-ins returned above are environment-less.
  const app = await AppModel.findById(appId);
  if (!app) {
    return {
      allowed: false,
      code: -32601,
      reason: `App "${appId}" not found.`,
    };
  }
  if (!(await ToolModel.isToolInEnvironment(tool.id, app.environmentId))) {
    return {
      allowed: false,
      code: -32601,
      reason: `Tool "${toolName}" is not available in the app's environment.`,
    };
  }

  const visibility = (tool.meta as { _meta?: { ui?: McpUiToolMeta } } | null)
    ?._meta?.ui?.visibility;
  if (visibility && !visibility.includes("app")) {
    return {
      allowed: false,
      code: -32601,
      reason: `Tool "${toolName}" is not accessible from MCP Apps (visibility: [${visibility.join(", ")}])`,
    };
  }

  // Policy is keyed by the resolved (stored) name, so a suffix-addressed tool
  // cannot slip past a policy attached to its full name.
  const resolvedToolName = tool.toolName;
  const refusal = await enforceAppRuntimeInvocationPolicy({
    resolvedToolName,
    resolvedToolId: tool.id,
    displayName: toolName,
    toolInput,
    userId,
    isContextTrusted: params.isContextTrusted,
    treatRequireApprovalAsBlock: params.treatRequireApprovalAsBlock,
  });
  if (refusal) {
    return { allowed: false, ...refusal };
  }

  return { allowed: true, kind: "upstream", resolvedToolName };
}

/**
 * Evaluate a resolved tool's invocation policy for an app-runtime call — shared
 * by every app-runtime entrypoint (the owned-app gate above and the
 * server-scoped app proxy) so they cannot diverge on enforcement.
 *
 * `resolvedToolName` must be the stored (slugified) name the policy is keyed by.
 * `isContextTrusted` mirrors the caller's trust: iframe runtimes pass `true`, so
 * only `block_always`/`require_approval` gate and a no-policy tool stays
 * callable; `preview_app_tool` forwards the chat's real trust so
 * `block_when_context_is_untrusted` still fires. `treatRequireApprovalAsBlock`
 * blocks `require_approval` where the caller has no way to present the prompt
 * (the sandbox runtimes). Returns a JSON-RPC refusal `{ code, reason }`, or `null`
 * when the call is allowed.
 */
export async function enforceAppRuntimeInvocationPolicy(params: {
  resolvedToolName: string;
  // The id of the resolved tool row the caller will execute. Policy is evaluated
  // against this exact row instead of a name lookup, which the app-runtime path
  // (agentId "") could otherwise resolve to a different same-named row.
  resolvedToolId: string;
  displayName: string;
  toolInput: Record<string, unknown>;
  userId: string;
  isContextTrusted: boolean;
  treatRequireApprovalAsBlock: boolean;
}): Promise<{ code: number; reason: string } | null> {
  const {
    resolvedToolName,
    resolvedToolId,
    displayName,
    toolInput,
    userId,
    isContextTrusted,
    treatRequireApprovalAsBlock,
  } = params;

  // The viewer is the principal executing the call (as the app owner, with the
  // viewer's credentials), so a team-scoped policy is matched against the
  // viewer's teams — not an empty set, which would silently miss them.
  const policyContext = { teamIds: await TeamModel.getUserTeamIds(userId) };

  const verdict = await ToolInvocationPolicyModel.evaluateBatch(
    "",
    [{ toolCallName: resolvedToolName, toolInput }],
    policyContext,
    isContextTrusted,
    new Map([[resolvedToolName, resolvedToolId]]),
  );
  if (!verdict.isAllowed) {
    return {
      code: -32601,
      reason: `Tool "${displayName}" is blocked by a tool-invocation policy — a security guardrail enforced by ${archestraMcpBranding.catalogName}, not by the tool itself: ${verdict.reason}`,
    };
  }

  if (treatRequireApprovalAsBlock) {
    const requiresApproval =
      await ToolInvocationPolicyModel.checkApprovalRequired(
        resolvedToolName,
        toolInput,
        policyContext,
        resolvedToolId,
      );
    if (requiresApproval) {
      return {
        code: -32601,
        reason: `Tool "${displayName}" requires human approval, which the app sandbox cannot present; an authoring agent can exercise it via preview_app_tool.`,
      };
    }
  }

  return null;
}
