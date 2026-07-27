import * as yaml from "js-yaml";
import { getMcpCatalogPermissionChecker } from "@/auth/mcp-catalog-permissions";
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
  | "serverType"
  | "environmentId"
  | "localConfig"
  | "catalogItemApprovalStatus"
  | "authorId"
  | "deploymentSpecYaml"
>;

// === Public API ===

/**
 * Enforce the trusted-image-registry policy at install time. Returns when the
 * install may proceed; throws `ApiError(403)` when it is blocked.
 *
 * Not gated (exempt server, privileged author, no allowlist, or the image is
 * trusted) → proceed, clearing any stale `pending` flag. Gated → an `approved`
 * catalog item proceeds, otherwise the item is marked `pending` (compare-and-set,
 * never clobbering a concurrent admin decision) and the install is blocked.
 */
export async function assertInstallAllowedOrBlock(params: {
  catalogItem: InstallPolicyCatalogItem;
  organizationId: string;
}): Promise<void> {
  const { blocked, policy } = await applyImageGate(params);
  if (blocked && policy.gated) {
    logger.info(
      {
        catalogId: params.catalogItem.id,
        images: policy.images,
        environment: policy.environmentLabel,
      },
      "Install blocked: catalog image not in trusted registries (pending approval)",
    );
    throw new ApiError(403, blockedMessage(policy.environmentLabel));
  }
}

/**
 * Non-throwing counterpart to {@link assertInstallAllowedOrBlock} for the
 * catalog-edit path: flips the flag to `pending` and returns `true` when the
 * (possibly new) image is gated and not yet approved, so the caller can skip the
 * auto-reinstall and keep the running pod on its old, approved image. Clears a
 * stale `pending` flag when no longer gated.
 */
export async function holdInstallIfImageGated(params: {
  catalogItem: InstallPolicyCatalogItem;
  organizationId: string;
}): Promise<boolean> {
  const { blocked } = await applyImageGate(params);
  return blocked;
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
  const gateable = items.filter(
    (item) =>
      item.catalogItemApprovalStatus !== "approved" &&
      isGateableLocalImage(item),
  );
  if (gateable.length === 0) return required;

  // Privileged authors (admin / team-admin) are exempt — only a plain member's
  // untrusted image needs approval. Resolve privilege once per distinct author.
  const privilegedByAuthor = new Map<string, boolean>();
  await Promise.all(
    [
      ...new Set(
        gateable
          .map((c) => c.authorId)
          .filter((id): id is string => id !== null),
      ),
    ].map(async (authorId) => {
      privilegedByAuthor.set(
        authorId,
        await isAuthorPrivileged({ authorId, organizationId }),
      );
    }),
  );
  const candidates = gateable.filter(
    (c) => !(c.authorId && privilegedByAuthor.get(c.authorId)),
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
    if (gatedImagesForRegistries(item, registries).length > 0) {
      required.add(item.id);
    }
  }
  return required;
}

// === Internal helpers ===

type InstallImagePolicy =
  | { gated: false }
  | { gated: true; images: string[]; environmentLabel: string };

/**
 * Shared core for the gate: evaluates the policy and applies the flag side
 * effects (clear a stale `pending` when no longer gated; CAS to `pending` when
 * gated and undecided). Returns whether the install is blocked along with the
 * evaluated policy, so callers can either throw or skip the auto-reinstall.
 */
async function applyImageGate(params: {
  catalogItem: InstallPolicyCatalogItem;
  organizationId: string;
}): Promise<{ blocked: boolean; policy: InstallImagePolicy }> {
  const { catalogItem } = params;
  const policy = await evaluateInstallImagePolicy(params);

  if (!policy.gated) {
    if (catalogItem.catalogItemApprovalStatus === "pending") {
      await InternalMcpCatalogModel.clearImageApprovalPending(catalogItem.id);
    }
    return { blocked: false, policy };
  }

  if (catalogItem.catalogItemApprovalStatus === "approved") {
    return { blocked: false, policy };
  }

  // No decision yet (or already pending): record pending. The CAS returns the
  // winning status so a concurrent admin approval wins.
  const winning = await InternalMcpCatalogModel.markImageApprovalPending(
    catalogItem.id,
  );
  return { blocked: winning.status !== "approved", policy };
}

/**
 * Decide whether a local install's images are gated by the target environment's
 * trusted image registries. Gated for any local catalog item with a custom image
 * (not the platform base image) authored by a NON-admin (anyone without
 * `mcpServerInstallation:admin` — admins curate the registry and are trusted to
 * vet images), when the resolved environment has a non-empty trusted list that at
 * least one of the item's images does not match. Everything else
 * (remote/builtin/app, base image only, admin author, no trusted list, or all
 * images matching) is exempt.
 */
async function evaluateInstallImagePolicy(params: {
  catalogItem: InstallPolicyCatalogItem;
  organizationId: string;
}): Promise<InstallImagePolicy> {
  const { catalogItem, organizationId } = params;

  if (!isGateableLocalImage(catalogItem)) return { gated: false };

  if (
    await isAuthorPrivileged({
      authorId: catalogItem.authorId,
      organizationId,
    })
  ) {
    return { gated: false };
  }

  const { registries, label } = await resolveTrustedImageRegistries({
    environmentId: catalogItem.environmentId,
    organizationId,
  });
  const images = gatedImagesForRegistries(catalogItem, registries);
  if (images.length === 0) {
    return { gated: false };
  }

  return { gated: true, images, environmentLabel: label };
}

/**
 * Whether the catalog item's author holds `mcpServerInstallation:admin` — the
 * capability that both curates the registry and approves gated images. Such
 * authors are trusted to vet their own custom images, so they bypass the gate. A
 * null author (system / legacy row) is treated as non-admin so its image is still
 * vetted.
 */
async function isAuthorPrivileged(params: {
  authorId: string | null;
  organizationId: string;
}): Promise<boolean> {
  if (!params.authorId) return false;
  const checker = await getMcpCatalogPermissionChecker({
    userId: params.authorId,
    organizationId: params.organizationId,
  });
  return checker.isAdmin;
}

/** A local catalog item that would run at least one custom image. */
function isGateableLocalImage(item: InstallPolicyCatalogItem): boolean {
  return collectGateableImages(item).length > 0;
}

/**
 * Given an already-gateable item, which of the images it would run are actually
 * disallowed by these resolved trusted registries? A NULL/empty list means "no
 * restriction", so nothing is gated.
 */
function gatedImagesForRegistries(
  item: InstallPolicyCatalogItem,
  registries: TrustedImageRegistries | null,
): string[] {
  if (!registries || registries.length === 0) return [];
  return collectGateableImages(item).filter(
    (image) => !imageMatchesTrustedRegistries(image, registries),
  );
}

/**
 * Every custom container image a local catalog item would actually run:
 * `localConfig.dockerImage` plus every `containers`/`initContainers` image
 * declared in a custom `deploymentSpecYaml`.
 *
 * The custom YAML must be included because it — not `localConfig` — is the
 * deployment source when present: the runtime only overwrites metadata, labels,
 * and selectors, so a container image written there reaches the pod verbatim.
 * Checking `dockerImage` alone would let a trusted value there vouch for an
 * untrusted image in the YAML.
 *
 * Dropped: the platform base image (the trusted default) and the
 * `${archestra.docker_image}` placeholder, which the runtime substitutes with
 * `localConfig.dockerImage` — already covered on its own. Any OTHER unresolved
 * placeholder is kept as-is; it cannot match a trusted registry, so it gates.
 */
function collectGateableImages(item: InstallPolicyCatalogItem): string[] {
  if (item.serverType !== "local") return [];

  const images = new Set<string>();
  const collect = (raw: string | null | undefined) => {
    const image = raw?.trim();
    if (!image) return;
    if (image === config.orchestrator.mcpServerBaseImage) return;
    if (image === DOCKER_IMAGE_PLACEHOLDER) return;
    images.add(image);
  };

  collect(item.localConfig?.dockerImage);
  for (const image of extractYamlContainerImages(item.deploymentSpecYaml)) {
    collect(image);
  }
  return [...images];
}

/**
 * Container and initContainer images declared by a custom deployment YAML.
 *
 * A YAML that fails to parse yields nothing on purpose: the runtime falls back
 * to the generated spec in exactly that case, and that spec runs
 * `localConfig.dockerImage`, which is collected separately.
 */
function extractYamlContainerImages(
  deploymentSpecYaml: string | null | undefined,
): string[] {
  if (!deploymentSpecYaml?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = yaml.load(deploymentSpecYaml);
  } catch {
    return [];
  }

  const podSpec = (
    parsed as {
      spec?: { template?: { spec?: Record<string, unknown> } };
    } | null
  )?.spec?.template?.spec;
  if (!podSpec || typeof podSpec !== "object") return [];

  const images: string[] = [];
  for (const field of ["containers", "initContainers"] as const) {
    const containers = podSpec[field];
    if (!Array.isArray(containers)) continue;
    for (const container of containers) {
      const image = (container as { image?: unknown } | null)?.image;
      if (typeof image === "string") images.push(image);
    }
  }
  return images;
}

/**
 * The runtime placeholder that resolves to `localConfig.dockerImage`. Built from
 * parts so the literal doesn't trip the template-curly lint rule.
 */
const DOCKER_IMAGE_PLACEHOLDER = `\${archestra.docker_image}`;

function blockedMessage(environmentLabel: string): string {
  return `This server's image is not in the trusted image registries for "${environmentLabel}" and is blocked pending administrator approval.`;
}
