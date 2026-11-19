import { createHash } from "node:crypto";
import OpenAppaSessionModel from "@/models/openappa-session";
import { ApiError } from "@/types/api";
import {
  type AppaChildTrajectoryReceipt,
  stripChildTrajectoryReceipts,
} from "./child-trajectory-receipt";
import type { OpenAppaSession } from "./service";

export async function retainChildTrajectoryReference(
  session: OpenAppaSession,
  footer: string,
): Promise<string> {
  // The parent already released the spawn. The child may not have made its
  // first runtime call yet, so persist under the existing parent, not the child.
  // The signed binding still seals this child's complete identity.
  const storageSession = {
    ...session,
    session_id: session.parent_id ?? session.session_id,
  };
  const receipt = await OpenAppaSessionModel.ensureReceiptToken({
    organizationId: storageSession.organization_id,
    sessionId: storageSession.session_id,
  });
  // Older/partially retained families can still use the full signed proof.
  // Never publish an unresolvable short reference.
  if (!receipt) return footer;
  const digest = bindingDigest(footer);
  await OpenAppaSessionModel.retainChildBinding({
    session: storageSession,
    digest,
    footer,
  });
  return `▄█▄▄▄█▄  started subagent ${receipt.token}@${digest}`;
}

export async function resolveChildTrajectoryReferences(params: {
  organizationId: string;
  callerId: string | undefined;
  references: readonly string[];
}): Promise<AppaChildTrajectoryReceipt[]> {
  if (params.references.length > 64)
    throw new ApiError(400, "OpenAPPA received too many child references");
  const references = [...new Set(params.references)];
  const owners = await OpenAppaSessionModel.receiptTokenOwners({
    organizationId: params.organizationId,
    tokens: references.map((reference) => reference.split("@")[0]),
  });
  const receipts: AppaChildTrajectoryReceipt[] = [];
  for (const reference of references) {
    const [code, digest] = reference.split("@");
    const owner = owners.get(code);
    const footer =
      owner && owner.callerId === params.callerId
        ? await OpenAppaSessionModel.childBinding({
            organizationId: params.organizationId,
            callerId: owner.callerId,
            sessionId: owner.sessionId,
            digest,
          })
        : undefined;
    if (!footer || bindingDigest(footer) !== digest)
      throw new ApiError(
        409,
        "OpenAPPA could not resolve the protected child reference",
      );
    const parsed = stripChildTrajectoryReceipts(footer).receipts;
    if (parsed.length !== 1)
      throw new ApiError(409, "OpenAPPA retained an invalid child binding");
    // Normal trajectory verification still checks the HMAC, organization,
    // caller and native identity. A successful lookup is not authorization.
    receipts.push(parsed[0]);
  }
  return receipts;
}

function bindingDigest(footer: string): string {
  return createHash("sha256")
    .update(footer)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}
