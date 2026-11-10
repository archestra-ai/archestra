// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import type { DispatchPolicy } from "@archestra/openappa-rs";
import { ApiError } from "@/types/api";
import { clientSessionId } from "./actor";
import { mintChildTrajectoryReceipt } from "./child-trajectory-receipt";
import { retainChildTrajectoryReference } from "./child-trajectory-reference";
import { mintDelegationMarker } from "./delegation";
import {
  addressRuntimeChild,
  loadChildReturns,
  type OpenAppaSession,
} from "./service";

/** An expected source refusal, delivered as a completed policy response. */
export class GrokChildResumeRefusal extends ApiError {
  constructor() {
    super(
      409,
      "OpenAPPA could not verify this Grok resume source as a completed protected child of this session. The resume was refused before launch; no child was started.",
    );
  }
}

/**
 * Grok resumes a logical child by copying its transcript into a new native ID.
 * Bind that ID back to the existing governed actor; opening a fresh fork would
 * discard the source's restrictions. Only this parent's retained ChildEnd
 * identifies a resumable source. Client-authored IDs and copied text do not.
 *
 * Called only after the ordinary continuation call was admitted by policy.
 * Its original return contract remains in force.
 */
export async function grokChildResumeSuffix(
  params: {
    session: OpenAppaSession;
    callId: string;
    sourceNativeId: string;
    spawnerNativeId: string;
    prompt: string;
    runtimeSessionId?: string;
  },
  policy?: DispatchPolicy,
): Promise<string> {
  const { session } = params;
  if (!/^[0-9a-f-]{36}$/.test(params.sourceNativeId) || !params.prompt.trim())
    throw new GrokChildResumeRefusal();
  const returns = await loadChildReturns({
    organizationId: session.organization_id,
    parentSessionId: session.session_id,
  });
  const sources = returns.filter(
    (entry) =>
      entry.childNativeId === params.sourceNativeId &&
      entry.spawnCallId &&
      entry.childSessionId.startsWith(`${session.session_id}:`),
  );
  const source = sources[0];
  if (
    !source?.spawnCallId ||
    sources.some(
      (entry) =>
        entry.childSessionId !== source.childSessionId ||
        entry.spawnCallId !== source.spawnCallId,
    )
  )
    throw new GrokChildResumeRefusal();
  await addressRuntimeChild(
    {
      session,
      childSessionId: source.childSessionId,
      operationId: `child_address:grok-resume:${params.callId}`,
    },
    policy,
  );
  const parentId = clientSessionId(session.session_id);
  const common = {
    organizationId: session.organization_id,
    callerId: session.caller_id,
    parentId,
    spawnerNativeId: params.spawnerNativeId,
    spawnCallId: source.spawnCallId,
    ...(params.runtimeSessionId
      ? { runtimeSessionId: params.runtimeSessionId }
      : {}),
  };
  const receipt = mintChildTrajectoryReceipt({
    ...common,
    childId: clientSessionId(source.childSessionId),
    // Grok assigns the new native ID after launch. The signed actor binding
    // is fixed now; the first child response seals its observed native ID.
  });
  const marker = mintDelegationMarker({ ...common, prompt: params.prompt });
  if (!receipt || !marker)
    throw new ApiError(503, "OpenAPPA could not protect this Grok resume");
  // Ingress removes the receipt before checking the marker's prompt digest.
  const visibleReceipt = await retainChildTrajectoryReference(session, receipt);
  return `\n\n${marker}\n\n${visibleReceipt}`;
}
