import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import config from "@/config";
import OpenAppaSessionModel from "@/models/openappa-session";
import OpenAppaSpawnCorrelationModel from "@/models/openappa-spawn-correlation";
import { childSessionId } from "@/openappa/actor";
import { withoutChildReturnMarker } from "@/openappa/child-return";
import {
  delegationEnabled,
  mintDelegationMarker,
  stripDelegationMarkers,
} from "@/openappa/delegation";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import {
  approveSpawnReturn,
  evaluateToolCalls,
  loadChildReturns,
  nativeGuardrailsActive,
} from "@/openappa/service";
import { withoutTrajectoryStamp } from "@/openappa/trajectory-stamp";
import { ApiError } from "@/types";
import { errorResult, successResult } from "./helpers";
import type { ArchestraContext } from "./types";

/** Gateway ownership comes from authentication, never the child's headers. */
export async function runGuardedForegroundDelegation(params: {
  context: ArchestraContext;
  toolName: string;
  message: string;
  execute: (input: {
    message: string;
    parentSessionId?: string;
    toolCallId?: string;
    sessionId?: string;
  }) => Promise<{ text: string }>;
}): Promise<CallToolResult> {
  const { context } = params;
  if (
    context.gatewayRequest &&
    !context.openappaSession &&
    (await nativeGuardrailsActive())
  ) {
    return errorResult(
      "OpenAPPA foreground delegation requires an authenticated parent session. Send X-Appa-Session-ID with the caller's credential before starting a delegated task.",
    );
  }
  if (!context.openappaSession || !(await nativeGuardrailsActive())) {
    return successResult(
      (
        await params.execute({
          message: params.message,
          parentSessionId:
            context.appaSessionId ??
            context.sessionId ??
            context.conversationId ??
            context.isolationKey,
          toolCallId: context.currentToolCallId,
          sessionId:
            context.sessionId ?? context.conversationId ?? context.isolationKey,
        })
      ).text,
    );
  }
  const parent = context.openappaSession;
  if (!delegationEnabled()) {
    throw new ApiError(503, "OpenAPPA cannot protect the delegated child");
  }
  if (
    parent.organization_id !== context.organizationId ||
    !context.userId ||
    parent.caller_id !== `user:${context.userId}`
  ) {
    throw new ApiError(
      403,
      "OpenAPPA delegation parent does not belong to the authenticated caller",
    );
  }
  const body = { messages: [{ role: "user", content: params.message }] };
  stripDelegationMarkers({ family: "openai:chatCompletions", body });
  const message = body.messages[0].content;
  const sourceCallId = context.currentToolCallId
    ? withoutTrajectoryStamp(context.currentToolCallId)
    : undefined;
  const original = sourceCallId
    ? await OpenAppaSpawnCorrelationModel.releasedSpawnCall({
        organizationId: parent.organization_id,
        callerId: parent.caller_id,
        parentSessionId: parent.session_id,
        toolCallId: sourceCallId,
      })
    : null;
  if (
    original &&
    (original.tool !== params.toolName ||
      !isDeepStrictEqual(original.arguments, { message }))
  ) {
    throw new ApiError(
      409,
      "OpenAPPA delegation differs from the released fork",
    );
  }
  const toolCallId =
    original && sourceCallId
      ? sourceCallId
      : `gateway-child:${sourceCallId ?? randomUUID()}`;
  const childId = childSessionId(parent.session_id, toolCallId);
  const released =
    original ??
    (await OpenAppaSpawnCorrelationModel.releasedSpawnCall({
      organizationId: parent.organization_id,
      callerId: parent.caller_id,
      parentSessionId: parent.session_id,
      toolCallId,
    }));
  if (
    released &&
    (released.tool !== params.toolName ||
      !isDeepStrictEqual(released.arguments, { message }))
  ) {
    throw new ApiError(
      409,
      "OpenAPPA delegation differs from the released fork",
    );
  }
  const existingChild = await OpenAppaSessionModel.familySession({
    organizationId: parent.organization_id,
    callerId: parent.caller_id,
    sessionId: childId,
  });
  if (existingChild) {
    const returns = await loadChildReturns({
      organizationId: parent.organization_id,
      parentSessionId: parent.session_id,
    });
    const crossed = returns.filter(
      (record) =>
        record.childSessionId === childId && record.spawnCallId === toolCallId,
    );
    if (
      !released ||
      existingChild.parentId !== parent.session_id ||
      crossed.length !== 1
    ) {
      throw new ApiError(
        409,
        "OpenAPPA delegated execution has no completed return; it cannot be replayed",
      );
    }
    await approveSpawnReturn({
      session: parent,
      toolCallId,
      childId,
      value: crossed[0].value,
    });
    return successResult(crossed[0].value);
  }
  if (!released) {
    const [decision] = await evaluateToolCalls(
      parent,
      [
        {
          id: toolCallId,
          name: params.toolName,
          arguments: { message },
        },
      ],
      {
        canonicalize: (name) => name,
        isSpawn: () => true,
        supportsDelegation: true,
      },
    );
    if (decision.kind !== "allow") {
      if (decision.kind !== "deny")
        throw new ApiError(409, "OpenAPPA did not release the delegation fork");
      return {
        ...errorResult(decision.feedback),
        structuredContent: {
          offers: (decision.offers ?? []).map((offerId) =>
            signOfferClaims(
              unsignedOfferClaims({
                organizationId: parent.organization_id,
                callerId: parent.caller_id,
                sessionId: parent.session_id,
                parentId: parent.parent_id,
                offerId,
                tool: params.toolName,
                spelling: params.toolName,
              }),
              config.openappa.offerSigningSecret,
            ),
          ),
        },
      };
    }
    const grant = await OpenAppaSpawnCorrelationModel.releasedSpawnCall({
      organizationId: parent.organization_id,
      callerId: parent.caller_id,
      parentSessionId: parent.session_id,
      toolCallId,
    });
    if (
      !grant ||
      grant.tool !== params.toolName ||
      !isDeepStrictEqual(grant.arguments, { message })
    ) {
      throw new ApiError(
        503,
        "OpenAPPA did not retain the released delegation fork",
      );
    }
  }
  const marker = mintDelegationMarker({
    organizationId: parent.organization_id,
    callerId: parent.caller_id,
    parentId: parent.session_id,
    spawnerNativeId: parent.session_id,
    prompt: message,
    spawnCallId: toolCallId,
  });
  if (!marker)
    throw new ApiError(503, "OpenAPPA cannot protect the delegated child");
  // A durable single execution claim, not a pooled connection held while
  // the child runs. Interrupted claims cannot replay ambiguous effects.
  if (
    !(await OpenAppaSpawnCorrelationModel.claimRuntimeDispatch({
      organizationId: parent.organization_id,
      callerId: parent.caller_id,
      sessionId: parent.session_id,
      toolCallId,
      spawn: true,
      dispatch: "gateway",
    }))
  ) {
    throw new ApiError(
      409,
      "OpenAPPA delegated execution was already claimed; it cannot be replayed",
    );
  }
  const result = await params.execute({
    message: `${message}\n\n${marker}`,
    parentSessionId: parent.session_id,
    toolCallId,
    sessionId: parent.session_id,
  });
  const value = withoutChildReturnMarker(result.text);
  const returns = await loadChildReturns({
    organizationId: parent.organization_id,
    parentSessionId: parent.session_id,
  });
  if (
    !returns.some(
      (record) =>
        record.childSessionId === childId &&
        record.spawnCallId === toolCallId &&
        record.value === value,
    )
  ) {
    throw new ApiError(
      409,
      "OpenAPPA withheld a delegated result without its exact ChildEnd crossing",
    );
  }
  await approveSpawnReturn({ session: parent, toolCallId, childId, value });
  return successResult(value);
}
