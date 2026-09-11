import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hasAnyAgentTypeAdminPermission, userHasPermission } from "@/auth";
import type { TokenAuthContext } from "@/clients/mcp-client";
import AgentTeamModel from "@/models/agent-team";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import { canonicalNativeMcpArguments } from "./appa-codex-native-bridge";

type NativeCallBinding = {
  purpose: "native_call";
  principalUserId: string;
  gatewayProfileId?: string;
  threadId: string;
  itemId: string;
  toolName: string;
  argumentsCanonical: string;
  executionArgumentsCanonical: string;
};

type NativeMcpReceipt = {
  version: 1;
  status: "success" | "failure";
  result: CallToolResult;
};

type NativeMcpExecutionOutcome =
  | { status: "success" | "failure"; result: CallToolResult }
  | { status: "indeterminate"; message: string };

/**
 * Gateway-owned at-most-once dispatch boundary for issued native business
 * calls. Client metadata only locates the sealed binding; it never authorizes
 * execution or proves an outcome.
 */
export class DurableAppaNativeMcpExecutionService {
  async claim(params: {
    tokenAuth: TokenAuthContext | undefined;
    callId: string;
    toolName: string;
    args: Record<string, unknown>;
    executionArgs: Record<string, unknown>;
    actualGatewayProfileId: string;
    wireContext: { threadId?: string; itemId?: string };
  }): Promise<
    | { state: "acquired"; callId: string; frameId: string; scope: NativeScope }
    | { state: "completed"; result: Record<string, unknown> }
    | { state: "unavailable" }
  > {
    if (!isNativeCallId(params.callId)) return { state: "unavailable" };
    const userId = params.tokenAuth?.userId;
    const organizationId = params.tokenAuth?.organizationId;
    if (
      !userId ||
      !organizationId ||
      !params.tokenAuth ||
      !isUserPrincipal(params.tokenAuth)
    ) {
      return { state: "unavailable" };
    }

    // This query is intentionally metadata-only. Do not decrypt the alias
    // before both organization scope and originating-profile access are known.
    const metadata =
      await AppaProxyWireModel.findNativeCallMetadataForOrganization({
        callId: params.callId,
        organizationId,
      });
    if (!metadata) return { state: "unavailable" };
    const [hasReadPermission, isAgentAdmin] = await Promise.all([
      userHasPermission(userId, organizationId, "agent", "read"),
      hasAnyAgentTypeAdminPermission({ userId, organizationId }),
    ]);
    if (
      !hasReadPermission ||
      !(await AgentTeamModel.userHasAgentAccess(
        userId,
        metadata.session.profileId,
        isAgentAdmin,
      ))
    ) {
      return { state: "unavailable" };
    }
    const scope = {
      sessionId: metadata.session.id,
      ownerScopeHash: metadata.session.ownerScopeHash,
    };
    const binding = parseBinding(
      await AppaProxyWireModel.readNativeCallAliasMetadata({
        ...scope,
        aliasId: metadata.alias.id,
      }),
    );
    const argumentsCanonical = canonicalNativeMcpArguments(params.args);
    const executionArgumentsCanonical = canonicalNativeMcpArguments(
      params.executionArgs,
    );
    if (
      !binding ||
      binding.gatewayProfileId !== params.actualGatewayProfileId ||
      binding.principalUserId !== userId ||
      binding.threadId !== params.wireContext.threadId ||
      binding.itemId !== params.wireContext.itemId ||
      binding.toolName !== params.toolName ||
      binding.argumentsCanonical !== argumentsCanonical ||
      binding.executionArgumentsCanonical !== executionArgumentsCanonical
    ) {
      return { state: "unavailable" };
    }

    try {
      const claim = await AppaProxyWireModel.claimNativeMcpExecution({
        ...scope,
        aliasId: metadata.alias.id,
        callId: params.callId,
        expectedExecutionArgumentsCanonical: executionArgumentsCanonical,
      });
      if (claim.state === "completed") {
        const receipt = await AppaProxyWireModel.findNativeMcpExecutionReceipt({
          ...scope,
          callId: params.callId,
        });
        const parsed = parseReceipt(receipt?.receipt);
        return parsed
          ? { state: "completed", result: parsed.result }
          : { state: "unavailable" };
      }
      return claim.state === "acquired"
        ? {
            state: "acquired",
            callId: params.callId,
            frameId: claim.frame.id,
            scope,
          }
        : { state: "unavailable" };
    } catch {
      return { state: "unavailable" };
    }
  }

  async complete(params: {
    scope: NativeScope;
    frameId: string;
    status: "success" | "failure";
    result: CallToolResult;
  }): Promise<CallToolResult | null> {
    const receipt: NativeMcpReceipt = {
      version: 1,
      status: params.status,
      result: params.result,
    };
    try {
      await AppaProxyWireModel.completeNativeMcpExecution({
        ...params.scope,
        frameId: params.frameId,
        receipt,
      });
      return receipt.result;
    } catch {
      // An external effect with no durable receipt is explicitly indeterminate.
      return null;
    }
  }

  /**
   * Parent hook API. Only a completed, schema-valid server receipt admits a
   * native business result; every other state is indeterminate by design.
   */
  async getNativeMcpExecutionOutcome(
    params: NativeScope & { callId: string },
  ): Promise<NativeMcpExecutionOutcome> {
    if (!isNativeCallId(params.callId)) return indeterminateOutcome();
    const found =
      await AppaProxyWireModel.findNativeMcpExecutionReceipt(params);
    const receipt =
      found?.state === "completed" ? parseReceipt(found.receipt) : null;
    return receipt
      ? { status: receipt.status, result: receipt.result }
      : indeterminateOutcome();
  }
}

type NativeScope = { sessionId: string; ownerScopeHash: string };

function isNativeCallId(value: string): boolean {
  return /^call_appa_[a-f0-9]{32}$/.test(value);
}

function parseBinding(value: unknown): NativeCallBinding | null {
  if (!isRecord(value) || value.purpose !== "native_call") return null;
  return typeof value.principalUserId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.itemId === "string" &&
    typeof value.toolName === "string" &&
    typeof value.argumentsCanonical === "string" &&
    typeof value.executionArgumentsCanonical === "string"
    ? (value as NativeCallBinding)
    : null;
}

function parseReceipt(value: unknown): NativeMcpReceipt | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.status !== "success" && value.status !== "failure") ||
    !isCallToolResult(value.result)
  ) {
    return null;
  }
  return value as NativeMcpReceipt;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    isRecord(value) &&
    Array.isArray(value.content) &&
    (value.isError === undefined || typeof value.isError === "boolean")
  );
}

function indeterminateOutcome(): NativeMcpExecutionOutcome {
  return {
    status: "indeterminate",
    message:
      "The native MCP execution receipt is unavailable or indeterminate and was not retried.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUserPrincipal(tokenAuth: TokenAuthContext): boolean {
  return Boolean(
    tokenAuth.isUserToken || tokenAuth.isSessionAuth || tokenAuth.isExternalIdp,
  );
}
