import {
  APP_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
  TOOL_READ_FILE_RAW_SHORT_NAME,
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
 * The App Data Store tools run in-process keyed by the route-bound appId.
 * Together with the LLM completion and the file tools they form the built-in
 * surface an app runtime may dispatch; every other Archestra tool (the
 * management/chat surface) is rejected by the gate.
 */
const APP_DATA_SHORT_NAMES = new Set<string>([
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
]);

/**
 * The file tools, which — unlike the other built-ins — exist only while the
 * skills-sandbox runtime is on. Kept as a set for the availability predicate.
 */
const APP_FILE_SHORT_NAMES = new Set<string>(
  APP_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
);

/** Audit-row stand-in for file bytes an app read. */
const REDACTED_FILE_CONTENT_TEXT = "[file content not persisted in audit logs]";

/**
 * Reserved Archestra built-ins an app runtime may dispatch via the SDK. Ask
 * {@link isAppRuntimeBuiltinAvailable} rather than this set directly — some are
 * feature-flagged.
 */
const APP_RUNTIME_BUILTIN_SHORT_NAMES = new Set<string>([
  ...APP_DATA_SHORT_NAMES,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
  ...APP_FILE_ARCHESTRA_TOOL_SHORT_NAMES,
]);

/**
 * Whether an app-runtime built-in is actually dispatchable right now. Set
 * membership alone is not enough for the file tools: they are registered only
 * when the skills-sandbox runtime is on (see `getArchestraMcpTools`), so with
 * the flag dark the gate would admit a call that dispatch then fails to
 * resolve. Every consumer — the gate, the in-process dispatch branch,
 * `tools/list`, and the SDK bootstrap — asks this one predicate, so a dark flag
 * removes the whole surface coherently.
 */
export function isAppRuntimeBuiltinAvailable(shortName: string): boolean {
  if (!APP_RUNTIME_BUILTIN_SHORT_NAMES.has(shortName)) return false;
  if (isAppFileToolShortName(shortName)) return config.skillsSandbox.enabled;
  return true;
}

/**
 * Whether a built-in is one of the app file tools. They are marked app-only in
 * `tools/list`: an embedding host's model must not roam the viewer's app files,
 * while the app's own code still calls them.
 */
export function isAppFileToolShortName(shortName: string): boolean {
  return APP_FILE_SHORT_NAMES.has(shortName);
}

/**
 * Redact an app-dispatched built-in's result before it is persisted as an audit
 * row. `read_file` returns the file's contents, and an app read must not create
 * a second, long-lived database copy of them — the structured metadata
 * (filename, size, line window) is kept, the content blocks are replaced. Every
 * other built-in's result passes through unchanged. Audit persistence stays
 * best-effort; this only shapes WHAT is stored, never whether the call
 * proceeds.
 */
export function redactAppBuiltinAuditResult(
  toolName: string,
  response: CallToolResult,
): CallToolResult {
  const shortName = archestraMcpBranding.getToolShortName(toolName);
  if (
    shortName !== TOOL_READ_FILE_SHORT_NAME &&
    shortName !== TOOL_READ_FILE_RAW_SHORT_NAME
  ) {
    return response;
  }
  // Error results carry diagnostics (not-found, size caps), never file bytes —
  // keep them intact for the audit trail.
  if (response.isError) return response;
  // structuredContent mirrors the bytes in `content` (read_file's text window)
  // or `contentBase64` (read_file_raw) — strip both the same way, keeping the
  // metadata for the audit trail.
  const structured =
    response.structuredContent && typeof response.structuredContent === "object"
      ? (() => {
          const {
            content: _content,
            contentBase64: _contentBase64,
            ...meta
          } = response.structuredContent as Record<string, unknown>;
          return meta;
        })()
      : response.structuredContent;
  return {
    ...response,
    structuredContent: structured,
    content: [{ type: "text", text: REDACTED_FILE_CONTENT_TEXT }],
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

  // Archestra built-ins: only the reserved app-runtime tools (App Data Store,
  // the LLM completion, the file tools) are dispatchable from an app; they
  // bypass invocation policy (consistent with the rest of the engine). RBAC is
  // still enforced per call, against the viewer, inside executeArchestraTool.
  if (archestraMcpBranding.isToolName(toolName)) {
    const shortName = archestraMcpBranding.getToolShortName(toolName);
    if (shortName && isAppRuntimeBuiltinAvailable(shortName)) {
      return { allowed: true, kind: "app-builtin" };
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

  // Environment fence: a tool whose catalog left the app's bound environment is
  // refused at call time even though its assignment row remains
  // (re-binding an app does not strip assignments). Reuses the same predicate as
  // the assignment fence so the two never diverge; Default-environment tools
  // are the org baseline and pass for any app environment. Only upstream tools
  // reach here — app-runtime built-ins returned above are environment-less.
  const app = await AppModel.findById(appId);
  if (!app) {
    return {
      allowed: false,
      code: -32601,
      reason: `App "${appId}" not found.`,
    };
  }
  if (
    !(await ToolModel.isToolInEnvironmentOrDefault(tool.id, app.environmentId))
  ) {
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
