import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { TimeInMs } from "@archestra/shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import { resolveVerifiedRuntimeAssociation } from "@/services/agent-runtime/runtime-identity";
import { getHitlReview, peekHitlRuling, recordHitlRuling } from "./hitl-review";
import type { OpenAppaSession } from "./service";

type RuntimeHitlDecision = "approve" | "deny";

type RuntimeHitlReview = {
  workspaceId: string;
  taskId: string;
  workloadName: string;
  organizationId: string;
  reviewerUserId: string | null;
  offerId: string;
  session: OpenAppaSession;
  text: string;
  tool?: string;
  arguments?: string;
};

const RUNTIME_HITL_TTL_MS = 10 * TimeInMs.Minute;

export async function bindRuntimeHitlReview(params: {
  session: OpenAppaSession;
  review: {
    offerId: string;
    text: string;
    tool?: string;
    arguments?: string;
  };
}): Promise<void> {
  const association = await resolveVerifiedRuntimeAssociation({
    organizationId: params.session.organization_id,
    sessionId: params.session.session_id,
    callerId: params.session.caller_id,
    ...(params.session.parent_id ? { parentId: params.session.parent_id } : {}),
  });
  if (!association) return;
  const review: RuntimeHitlReview = {
    workspaceId: association.workspaceId,
    taskId: association.taskId,
    workloadName: association.workloadName,
    organizationId: association.organizationId,
    reviewerUserId: association.actorUserId,
    offerId: params.review.offerId,
    session: {
      organization_id: params.session.organization_id,
      session_id: params.session.session_id,
      ...(params.session.caller_id
        ? { caller_id: params.session.caller_id }
        : {}),
      ...(params.session.parent_id
        ? { parent_id: params.session.parent_id }
        : {}),
    },
    text: params.review.text,
    ...(params.review.tool ? { tool: params.review.tool } : {}),
    ...(params.review.arguments ? { arguments: params.review.arguments } : {}),
  };
  await cacheManager.set(offerKey(review), review, RUNTIME_HITL_TTL_MS);
  await cacheManager.appendToList({
    key: reviewKey(association.organizationId, association.workspaceId),
    value: review.offerId,
    ttl: RUNTIME_HITL_TTL_MS,
  });
}

/** Do not send unattended runtime reviews to native forms that auto-decline. */
export async function awaitRuntimeHitlReview(params: {
  session: OpenAppaSession;
  offerId: string;
  userId?: string;
  signal?: AbortSignal;
}): Promise<"approve" | "deny" | "none" | "unavailable" | "not-runtime"> {
  const association = await resolveVerifiedRuntimeAssociation({
    organizationId: params.session.organization_id,
    callerId: params.session.caller_id,
    sessionId: params.session.session_id,
    parentId: params.session.parent_id,
  });
  if (!association) return "not-runtime";
  if (!association.actorUserId || association.actorUserId !== params.userId)
    return "unavailable";
  const deadline = Date.now() + RUNTIME_HITL_TTL_MS;
  while (!params.signal?.aborted && Date.now() < deadline) {
    const ruling = await peekHitlRuling(params);
    if (ruling) return ruling;
    if (!(await getHitlReview(params))) return "unavailable";
    try {
      await setTimeout(500, undefined, { signal: params.signal });
    } catch {
      return "unavailable";
    }
  }
  return "unavailable";
}

export async function readRuntimeHitlReview(params: {
  organizationId: string;
  workspaceId: string;
}): Promise<RuntimeHitlReview | undefined> {
  return loadReview(params);
}

export async function decideRuntimeHitlReview(params: {
  organizationId: string;
  workspaceId: string;
  offerId: string;
  reviewerUserId: string;
  decision: RuntimeHitlDecision;
}): Promise<
  | { status: "recorded" }
  | { status: "no_reviewer" }
  | { status: "missing" }
  | { status: "conflict" }
  | { status: "forbidden" }
> {
  const current = await cacheManager.get<RuntimeHitlReview>(offerKey(params));
  if (!current || current.offerId !== params.offerId) {
    return { status: current ? "conflict" : "missing" };
  }
  if (!current.reviewerUserId) return { status: "no_reviewer" };
  if (current.reviewerUserId !== params.reviewerUserId) {
    return { status: "forbidden" };
  }
  const taken = await cacheManager.getAndDelete<RuntimeHitlReview>(
    offerKey(current),
    { throwOnError: true },
  );
  if (
    !taken ||
    taken.offerId !== params.offerId ||
    taken.organizationId !== params.organizationId ||
    taken.workspaceId !== params.workspaceId ||
    taken.reviewerUserId !== params.reviewerUserId
  ) {
    return { status: "conflict" };
  }
  const recorded = await recordHitlRuling({
    session: taken.session,
    offerId: taken.offerId,
    ruling: params.decision,
  });
  return recorded ? { status: "recorded" } : { status: "conflict" };
}

async function loadReview(params: {
  organizationId: string;
  workspaceId: string;
}): Promise<RuntimeHitlReview | undefined> {
  const offers = await cacheManager.get<string[]>(
    reviewKey(params.organizationId, params.workspaceId),
  );
  for (const offerId of new Set(offers ?? [])) {
    const review = await cacheManager.get<RuntimeHitlReview>(
      offerKey({ ...params, offerId }),
    );
    if (
      review?.organizationId === params.organizationId &&
      review.workspaceId === params.workspaceId &&
      review.offerId === offerId &&
      (await getHitlReview({ session: review.session, offerId }))
    )
      return review;
  }
  return undefined;
}

function offerKey(params: {
  organizationId: string;
  workspaceId: string;
  offerId: string;
}): AllowedCacheKey {
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        params.organizationId,
        params.workspaceId,
        params.offerId,
      ]),
    )
    .digest("base64url");
  return `${CacheKey.OpenAppaRuntimeHitlReview}-${scope}`;
}

function reviewKey(
  organizationId: string,
  workspaceId: string,
): AllowedCacheKey {
  const scope = createHash("sha256")
    .update(JSON.stringify([organizationId, workspaceId]))
    .digest("base64url");
  return `${CacheKey.OpenAppaRuntimeHitlReview}-${scope}`;
}
