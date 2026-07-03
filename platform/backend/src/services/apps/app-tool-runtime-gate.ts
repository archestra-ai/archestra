import {
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
  TOOL_APP_LLM_COMPLETE_SHORT_NAME,
} from "@archestra/shared";
import type { McpUiToolMeta } from "@modelcontextprotocol/ext-apps";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import {
  AppModel,
  OrganizationModel,
  TeamModel,
  ToolInvocationPolicyModel,
  ToolModel,
} from "@/models";
import type { GlobalToolPolicy } from "@/types";

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
 * carries its own human-approval gate and does not. As everywhere in the policy
 * engine, a permissive (`globalToolPolicy`) org short-circuits to allow — so
 * per-tool block policies do not apply on this path in permissive orgs either.
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
  const { appId, organizationId, userId, toolName, toolInput } = params;

  // Archestra built-ins: only the reserved app-runtime tools (App Data Store +
  // the LLM completion) are dispatchable from an app; they bypass invocation
  // policy (consistent with the rest of the engine).
  if (archestraMcpBranding.isToolName(toolName)) {
    const shortName = archestraMcpBranding.getToolShortName(toolName);
    if (shortName && APP_RUNTIME_BUILTIN_SHORT_NAMES.has(shortName)) {
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
    displayName: toolName,
    toolInput,
    organizationId,
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
 * (the sandbox runtimes). Permissive orgs short-circuit to allow, as everywhere
 * in the policy engine. Returns a JSON-RPC refusal `{ code, reason }`, or `null`
 * when the call is allowed.
 */
export async function enforceAppRuntimeInvocationPolicy(params: {
  resolvedToolName: string;
  displayName: string;
  toolInput: Record<string, unknown>;
  organizationId: string;
  userId: string;
  isContextTrusted: boolean;
  treatRequireApprovalAsBlock: boolean;
}): Promise<{ code: number; reason: string } | null> {
  const {
    resolvedToolName,
    displayName,
    toolInput,
    organizationId,
    userId,
    isContextTrusted,
    treatRequireApprovalAsBlock,
  } = params;

  const organization = await OrganizationModel.getById(organizationId);
  const globalToolPolicy: GlobalToolPolicy =
    organization?.globalToolPolicy ?? "permissive";
  // The viewer is the principal executing the call (as the app owner, with the
  // viewer's credentials), so a team-scoped policy is matched against the
  // viewer's teams — not an empty set, which would silently miss them.
  const policyContext = { teamIds: await TeamModel.getUserTeamIds(userId) };

  const verdict = await ToolInvocationPolicyModel.evaluateBatch(
    "",
    [{ toolCallName: resolvedToolName, toolInput }],
    policyContext,
    isContextTrusted,
    globalToolPolicy,
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
        globalToolPolicy,
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
