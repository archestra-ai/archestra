import config from "@/config";
import logger from "@/logging";
import { InternalMcpCatalogModel } from "@/models";
import { resolveTrustedImageRegistries } from "@/services/environments/environment";
import { ApiError, type InternalMcpCatalog } from "@/types";
import { imageMatchesTrustedRegistries } from "@/utils/match-image-against-registries";

/**
 * The catalog fields the image-approval gate inspects. A `Pick` of the full
 * catalog item so callers can pass the row they already fetched.
 */
type InstallPolicyCatalogItem = Pick<
  InternalMcpCatalog,
  | "id"
  | "scope"
  | "serverType"
  | "environmentId"
  | "localConfig"
  | "catalogItemApprovalStatus"
  | "catalogItemApprovalReason"
>;

// === Public API ===

/**
 * Enforce the trusted-image-registry policy at install time. Returns when the
 * install may proceed; throws `ApiError(403)` when it is blocked.
 *
 * Not gated (exempt server, no allowlist, or the image is trusted) → proceed,
 * clearing any stale `pending` flag. Gated → an `approved` catalog item
 * proceeds, a `declined` one is rejected with the recorded reason, otherwise the
 * item is marked `pending` (compare-and-set, never clobbering a concurrent admin
 * decision) and the install is blocked.
 */
export async function assertInstallAllowedOrBlock(params: {
  catalogItem: InstallPolicyCatalogItem;
  organizationId: string;
}): Promise<void> {
  const { catalogItem, organizationId } = params;

  const policy = await evaluateInstallImagePolicy({
    catalogItem,
    organizationId,
  });

  if (!policy.gated) {
    if (catalogItem.catalogItemApprovalStatus === "pending") {
      await InternalMcpCatalogModel.clearImageApprovalPending(catalogItem.id);
    }
    return;
  }

  if (catalogItem.catalogItemApprovalStatus === "approved") return;
  if (catalogItem.catalogItemApprovalStatus === "declined") {
    logger.info(
      { catalogId: catalogItem.id, image: policy.image },
      "Install blocked: catalog image was declined",
    );
    throw new ApiError(
      403,
      declineMessage(catalogItem.catalogItemApprovalReason),
    );
  }

  // No decision yet (or already pending): record pending and block. The CAS
  // returns the winning decision so a concurrent admin approve/decline wins.
  const winning = await InternalMcpCatalogModel.markImageApprovalPending(
    catalogItem.id,
  );
  if (winning.status === "approved") return;
  if (winning.status === "declined") {
    throw new ApiError(403, declineMessage(winning.reason));
  }
  logger.info(
    {
      catalogId: catalogItem.id,
      image: policy.image,
      environment: policy.environmentLabel,
    },
    "Install blocked: catalog image not in trusted registries (pending approval)",
  );
  throw new ApiError(403, blockedMessage(policy.environmentLabel));
}

// === Internal helpers ===

type InstallImagePolicy =
  | { gated: false }
  | { gated: true; image: string; environmentLabel: string };

/**
 * Decide whether a local install's image is gated by the target environment's
 * trusted image registries. Gated only for a PERSONAL local catalog item with a
 * custom image (not the platform base image) when the resolved environment has a
 * non-empty trusted list the image does not match. Everything else is exempt.
 */
async function evaluateInstallImagePolicy(params: {
  catalogItem: InstallPolicyCatalogItem;
  organizationId: string;
}): Promise<InstallImagePolicy> {
  const { catalogItem, organizationId } = params;

  if (catalogItem.scope !== "personal") return { gated: false };
  if (catalogItem.serverType !== "local") return { gated: false };

  // No custom image → the platform default base image is used, which is never
  // gated.
  const image = catalogItem.localConfig?.dockerImage?.trim();
  if (!image) return { gated: false };
  if (image === config.orchestrator.mcpServerBaseImage) return { gated: false };

  const { registries, label } = await resolveTrustedImageRegistries({
    environmentId: catalogItem.environmentId,
    organizationId,
  });
  if (!registries || registries.length === 0) return { gated: false };
  if (imageMatchesTrustedRegistries(image, registries)) return { gated: false };

  return { gated: true, image, environmentLabel: label };
}

function blockedMessage(environmentLabel: string): string {
  return `This server's image is not in the trusted image registries for "${environmentLabel}" and is blocked pending administrator approval.`;
}

function declineMessage(reason: string | null | undefined): string {
  return reason
    ? `This server's image was declined by an administrator: ${reason}`
    : "This server's image was declined by an administrator.";
}
