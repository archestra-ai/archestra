/**
 * Binds an in-process subagent run (an `agent__*` delegation the platform
 * executes itself) to the child trajectory its parent's spawn prepared.
 *
 * The child's model requests reach the proxy over loopback, where any header is
 * anyone's to write, so the binding travels as a server-signed token. Only the
 * delegation executor mints it, after the runtime bound the child's fork.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import config from "@/config";
import { childSessionId } from "@/openappa/actor";
import type { OpenAppaSession } from "@/openappa/service";

export const APPA_SUBAGENT_BINDING_HEADER = "X-Archestra-Appa-Subagent";

const DOMAIN = "archestra.appa-subagent.v1";
const LIFETIME_MS = 24 * 60 * 60 * 1000;

const ClaimsSchema = z
  .object({
    v: z.literal(1),
    organizationId: z.string().min(1),
    agentId: z.uuid(),
    callerId: z.string().min(1).optional(),
    parentId: z.string().min(1),
    spawnCallId: z.string().min(1),
    expiresAt: z.number().int(),
  })
  .strict();

/** A verified in-process child: its trajectory and the spawn that opened it. */
export type SubagentBinding = {
  token: string;
  agentId: string;
  session: OpenAppaSession & { parent_id: string };
  spawnCallId: string;
};

/** The trajectory a parent's in-process spawn opens. */
export function subagentChildSession(
  parent: OpenAppaSession,
  spawnCallId: string,
): OpenAppaSession & { parent_id: string } {
  return {
    organization_id: parent.organization_id,
    ...(parent.caller_id ? { caller_id: parent.caller_id } : {}),
    session_id: childSessionId(parent.session_id, `agent:${spawnCallId}`),
    parent_id: parent.session_id,
  };
}

/**
 * Operation-id prefix of the child's admitted returns. The proxy ends a bound
 * child's turn through the runtime-return path, keyed by the spawn call.
 */
export function subagentReturnPrefix(spawnCallId: string): string {
  return `runtime-return:${spawnCallId}:`;
}

export function mintSubagentBinding(params: {
  agentId: string;
  parent: OpenAppaSession;
  spawnCallId: string;
}): SubagentBinding {
  const claims: z.infer<typeof ClaimsSchema> = {
    v: 1,
    organizationId: params.parent.organization_id,
    agentId: params.agentId,
    ...(params.parent.caller_id ? { callerId: params.parent.caller_id } : {}),
    parentId: params.parent.session_id,
    spawnCallId: params.spawnCallId,
    expiresAt: Date.now() + LIFETIME_MS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return {
    token: `${payload}.${sign(payload)}`,
    agentId: params.agentId,
    session: subagentChildSession(params.parent, params.spawnCallId),
    spawnCallId: params.spawnCallId,
  };
}

/** Null for a token that is malformed, forged, expired, or for another run. */
export function verifySubagentBinding(
  token: string | undefined,
  expected: { organizationId: string; agentId: string },
): SubagentBinding | null {
  if (!token || !config.openappa.offerSigningSecret) return null;
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(sign(payload));
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
    return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = ClaimsSchema.safeParse(decoded);
  if (!parsed.success) return null;
  const claims = parsed.data;
  if (
    claims.expiresAt <= Date.now() ||
    claims.organizationId !== expected.organizationId ||
    claims.agentId !== expected.agentId
  )
    return null;
  return {
    token,
    agentId: claims.agentId,
    session: subagentChildSession(
      {
        organization_id: claims.organizationId,
        ...(claims.callerId ? { caller_id: claims.callerId } : {}),
        session_id: claims.parentId,
      },
      claims.spawnCallId,
    ),
    spawnCallId: claims.spawnCallId,
  };
}

function sign(payload: string): string {
  return createHmac("sha256", config.openappa.offerSigningSecret)
    .update(`${DOMAIN}.${payload}`)
    .digest("base64url");
}
