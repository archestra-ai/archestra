import type { A2AActor } from "@/agents/a2a/a2a-base";
import { openappaCallerId, scopedSessionId } from "@/openappa/actor";
import type { OpenAppaSession } from "@/openappa/service";

/**
 * The OpenAPPA session a runtime container opens on its first proxy call.
 *
 * The image sends `X-Appa-Session-ID: ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID`.
 * That request is not platform loopback, so the proxy scopes the header to
 * its credential-proven caller. Personal and passthrough runtime keys prove
 * the acting user; org/team keys use their key ID. A raw workspace name is
 * not this session and must never be used for admission or egress.
 */
export function runtimeProxySession(params: {
  organizationId: string;
  virtualApiKeyId: string;
  workspaceId: string;
  actor: A2AActor;
}): OpenAppaSession {
  const callerId = openappaCallerId({
    userId: params.actor.kind === "user" ? params.actor.id : undefined,
    virtualApiKeyId: params.virtualApiKeyId,
  });
  if (!callerId) throw new Error("Runtime credential caller is missing");
  // Derive even while enforcement is off, so its off-start record uses the
  // same identity the proxy will use if enforcement is enabled later.
  return {
    organization_id: params.organizationId,
    caller_id: callerId,
    session_id: scopedSessionId(callerId, params.workspaceId),
  };
}
