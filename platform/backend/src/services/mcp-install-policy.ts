import config from "@/config";
import logger from "@/logging";
import { InternalMcpCatalogModel } from "@/models";
import { resolveTrustedImageRegistries } from "@/services/environments/environment";
import {
  ApiError,
  type InternalMcpCatalog,
  type TrustedImageRegistries,
} from "@/types";
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

/**
 * Annotate which of a catalog list's items would be blocked by the image gate if
 * installed right now — i.e. gated AND not yet `approved`. Used by the registry
 * list so the UI can prevent the install up front instead of failing on attempt.
 * Trusted registries are resolved once per distinct environment.
 */
export async function flagImageApprovalRequired(
  items: InstallPolicyCatalogItem[],
  organizationId: string,
): Promise<Set<string>> {
  const required = new Set<string>();
  const candidates = items.filter(
    (item) =>
      item.catalogItemApprovalStatus !== "approved" &&
      isGateableLocalImage(item),
  );
  if (candidates.length === 0) return required;

  const registriesByEnv = new Map<
    string | null,
    TrustedImageRegistries | null
  >();
  await Promise.all(
    [...new Set(candidates.map((c) => c.environmentId ?? null))].map(
      async (environmentId) => {
        const { registries } = await resolveTrustedImageRegistries({
          environmentId,
          organizationId,
        });
        registriesByEnv.set(environmentId, registries);
      },
    ),
  );

  for (const item of candidates) {
    const registries = registriesByEnv.get(item.environmentId ?? null) ?? null;
    if (imageIsGatedForRegistries(item, registries)) required.add(item.id);
  }
  return required;
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

  if (!isGateableLocalImage(catalogItem)) return { gated: false };

  const { registries, label } = await resolveTrustedImageRegistries({
    environmentId: catalogItem.environmentId,
    organizationId,
  });
  if (!imageIsGatedForRegistries(catalogItem, registries)) {
    return { gated: false };
  }

  // isGateableLocalImage guarantees a non-empty custom image here.
  const image = catalogItem.localConfig?.dockerImage?.trim() ?? "";
  return { gated: true, image, environmentLabel: label };
}

/** A personal local item with a custom image that isn't the platform base image. */
function isGateableLocalImage(item: InstallPolicyCatalogItem): boolean {
  if (item.scope !== "personal") return false;
  if (item.serverType !== "local") return false;
  const image = item.localConfig?.dockerImage?.trim();
  if (!image) return false;
  return image !== config.orchestrator.mcpServerBaseImage;
}

/**
 * Given an already-gateable item, is its image actually disallowed by these
 * resolved trusted registries? A NULL/empty list means "no restriction".
 */
function imageIsGatedForRegistries(
  item: InstallPolicyCatalogItem,
  registries: TrustedImageRegistries | null,
): boolean {
  if (!isGateableLocalImage(item)) return false;
  if (!registries || registries.length === 0) return false;
  const image = item.localConfig?.dockerImage?.trim() ?? "";
  return !imageMatchesTrustedRegistries(image, registries);
}

function blockedMessage(environmentLabel: string): string {
  return `This server's image is not in the trusted image registries for "${environmentLabel}" and is blocked pending administrator approval.`;
}

function declineMessage(reason: string | null | undefined): string {
  return reason
    ? `This server's image was declined by an administrator: ${reason}`
    : "This server's image was declined by an administrator.";
}
