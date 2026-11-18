import {
  ENVIRONMENT_CLUSTER_BUSY_CODE,
  ENVIRONMENT_CLUSTER_CLEANUP_FAILED_CODE,
  type EnvironmentDefaultableResource,
  hasScopedPermission,
} from "@archestra/shared";
import { daggerEnvironmentRuntimeManager } from "@/k8s/dagger-environment-runtime/manager";
import {
  environmentClusters,
  kubeconfigSecretValue,
} from "@/k8s/environment-clusters";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import { describeK8sApiError } from "@/k8s/shared";
import logger from "@/logging";
import {
  EnvironmentLabelModel,
  EnvironmentModel,
  EnvironmentResourceDefaultModel,
  InternalMcpCatalogModel,
  OrganizationModel,
  PlaywrightRuntimeModel,
} from "@/models";
import { ENVIRONMENT_CLUSTER_WRITE_LIFETIME_MS } from "@/models/environment";
import { secretManager } from "@/secrets-manager";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  ApiError,
  type CreateEnvironment,
  type EnvironmentList,
  type EnvironmentResourceDefaults,
  type EnvironmentRow,
  type InternalMcpCatalogServerType,
  type TrustedImageRegistries,
  type UpdateEnvironment,
  type UpdateEnvironmentResourceDefaults,
} from "@/types";
import { trackBackgroundWork } from "@/utils/background-work";
import { validateValuesAgainstRegex } from "@/utils/validate-values-against-regex";
import {
  removeEnvironmentClusterWorkloads,
  validateEnvironmentKubeconfig,
  validateEnvironmentKubeconfigRotation,
} from "./environment-cluster";
import { evaluateRemoteServerUrlAgainstNetworkPolicy } from "./remote-server-network-policy";

/**
 * Provision (or update) the environment's per-env Dagger engine + egress
 * NetworkPolicy in the background. Fire-and-forget: a k8s hiccup must not fail
 * environment CRUD, and the manager no-ops when code-runtime/k8s is off.
 */
function reconcileEnvironmentEngine(environment: EnvironmentRow): void {
  trackBackgroundWork(
    daggerEnvironmentRuntimeManager
      .reconcileEnvironment(environment)
      .catch((err) =>
        logger.error(
          { err, environmentId: environment.id },
          "[DaggerEnvRuntime] background reconcile failed",
        ),
      ),
  );
}

/** Persist the Environment-bound browser runtime, then provision its pod in the background. */
async function reconcilePlaywrightRuntime(
  environment: EnvironmentRow,
): Promise<void> {
  const server = await PlaywrightRuntimeModel.ensureForEnvironment({
    environmentId: environment.id,
    organizationId: environment.organizationId,
  });
  if (server && mcpServerRuntimeManager.isEnabled) {
    void mcpServerRuntimeManager
      .startServer(server)
      .catch((err) =>
        logger.error(
          { err, environmentId: environment.id },
          "[PlaywrightRuntime] background reconcile failed",
        ),
      );
  }
}

/**
 * Tear down the environment's Dagger engine after the environment is deleted,
 * so it does not leave a privileged pod and retained cache PVC behind.
 * Fire-and-forget for symmetry with reconcile: the row is already gone, a k8s
 * hiccup must not fail the deletion, and the manager no-ops when
 * code-runtime/k8s is off.
 */
function teardownEnvironmentEngine(environment: EnvironmentRow): void {
  trackBackgroundWork(
    daggerEnvironmentRuntimeManager
      .teardownEnvironmentEngine(environment)
      .catch((err) =>
        logger.error(
          { err, environmentId: environment.id },
          "[DaggerEnvRuntime] background teardown failed",
        ),
      ),
  );
}

/**
 * Move or provision the engines of agents with their own network policy after
 * the namespace they live in changed. Fire-and-forget like the environment's
 * own engine.
 */
function reconcileAgentEngines(filter: {
  organizationId: string;
  environmentId?: string;
}): void {
  trackBackgroundWork(
    daggerEnvironmentRuntimeManager
      .reconcileAgentEngines(filter)
      .catch((err) =>
        logger.error(
          { err, ...filter },
          "[DaggerEnvRuntime] background agent engine reconcile failed",
        ),
      ),
  );
}

// === Public API ===

export async function listEnvironments(params: {
  organizationId: string;
  userId: string;
  labels?: Record<string, string[]>;
}): Promise<EnvironmentList> {
  const { organizationId, userId, labels } = params;
  const [rows, defaultAssignedCatalogCount, resourceDefaults] =
    await Promise.all([
      EnvironmentModel.listForOrganization(organizationId, labels),
      EnvironmentModel.countDefaultAssigned(organizationId),
      EnvironmentResourceDefaultModel.getForOrganization(organizationId),
    ]);
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // The rows already establish organization ownership. Resolve the caller's
  // deployment grants once rather than repeating authorization for every row.
  const usableEnvironmentIds =
    await ResourcePermissions.getUsableEnvironmentIds({
      organizationId,
      userId,
      environmentIds: rows.map((environment) => environment.id),
    });
  const environments = rows.map((environment) => ({
    ...environment,
    canDeploy: usableEnvironmentIds.has(environment.id),
  }));
  // SPDX-SnippetEnd
  return { environments, defaultAssignedCatalogCount, resourceDefaults };
}

/**
 * Point one or more resource kinds at the environment their new items should
 * land in. Omitted kinds are untouched; an explicit null resets that kind to
 * the org Default environment. Each named environment must belong to the
 * organization, so a default can never point across tenants.
 */
export async function updateEnvironmentResourceDefaults(params: {
  organizationId: string;
  data: UpdateEnvironmentResourceDefaults;
}): Promise<EnvironmentResourceDefaults> {
  const { organizationId, data } = params;
  const changes = entriesOf(data);

  // Validate every named environment before writing any of them, so a payload
  // with one bad id is rejected whole rather than applied halfway.
  for (const [, environmentId] of changes) {
    if (environmentId === null) continue;
    const environment = await EnvironmentModel.findByIdForOrganization(
      environmentId,
      organizationId,
    );
    if (!environment) {
      throw new ApiError(404, "Environment not found");
    }
  }

  for (const [resource, environmentId] of changes) {
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource,
      environmentId,
    });
  }

  return EnvironmentResourceDefaultModel.getForOrganization(organizationId);
}

/**
 * The environment a newly created resource of this kind should be bound to when
 * its creator did not choose one. Returns null — the org Default environment,
 * i.e. the historical behavior — when no default is configured, or when the
 * caller may not deploy into the configured one. Falling
 * back rather than throwing keeps an admin's convenience setting from blocking
 * a create the caller is otherwise allowed to perform; explicitly *choosing*
 * that environment is still refused by `assertCanAssignEnvironment`.
 */
export async function resolveDefaultEnvironmentForNewResource(params: {
  organizationId: string;
  resource: EnvironmentDefaultableResource;
  userId: string;
}): Promise<string | null> {
  const { organizationId, resource, userId } = params;

  const environmentId = await EnvironmentResourceDefaultModel.findForResource({
    organizationId,
    resource,
  });
  if (!environmentId) return null;

  const environment = await EnvironmentModel.findByIdForOrganization(
    environmentId,
    organizationId,
  );
  if (!environment) return null;
  if (
    !(await canDeployToEnvironment({
      organizationId,
      userId,
      scope: environment.id,
    }))
  )
    return null;

  return environment.id;
}

export async function createEnvironment(params: {
  organizationId: string;
  /** The creator, who gets full access. Omitted for a system create. */
  userId?: string;
  data: CreateEnvironment;
}): Promise<EnvironmentRow> {
  const { organizationId, userId, data } = params;
  const existing = await EnvironmentModel.listForOrganization(organizationId);
  if (existing.some((e) => e.name === data.name)) {
    throw new ApiError(409, "An environment with this name already exists.");
  }
  if (!data.kubeconfig && data.agentRuntimePlatformBaseUrl) {
    throw new ApiError(400, PLATFORM_URL_NEEDS_OWN_CLUSTER_MESSAGE);
  }
  // The kubeconfig is stored before the row that points at it. A failed
  // insert takes the secret back out.
  const kubeconfig = data.kubeconfig
    ? await validateEnvironmentKubeconfig({
        kubeconfig: data.kubeconfig,
        namespace: data.namespace,
      })
    : null;
  if (kubeconfig && data.namespace) {
    await assertClusterNamespaceIsFree({
      server: kubeconfig.server,
      namespace: data.namespace,
    });
  }
  const kubeconfigSecret = kubeconfig
    ? await secretManager().createSecret(
        kubeconfigSecretValue(kubeconfig.normalized),
        `environment-kubeconfig-${data.name}`,
      )
    : null;
  let created: EnvironmentRow;
  try {
    created = await EnvironmentModel.create({
      organizationId,
      name: data.name,
      description: data.description ?? null,
      namespace: data.namespace ?? null,
      networkPolicy: data.networkPolicy ?? null,
      validationRegex: data.validationRegex ?? null,
      trustedImageRegistries: data.trustedImageRegistries ?? null,
      kubeconfig:
        kubeconfig && kubeconfigSecret
          ? { secretId: kubeconfigSecret.id, server: kubeconfig.server }
          : null,
      agentRuntimePlatformBaseUrl: data.agentRuntimePlatformBaseUrl ?? null,
      authorId: userId ?? null,
    });
  } catch (error) {
    if (kubeconfigSecret) await removeKubeconfigSecret(kubeconfigSecret.id);
    throw error;
  }

  if (data.labels?.length) {
    await EnvironmentLabelModel.syncLabels(created.id, data.labels);
  }

  reconcileEnvironmentEngine(created);
  await reconcilePlaywrightRuntime(created);
  return created;
}

export async function updateEnvironment(params: {
  id: string;
  organizationId: string;
  data: UpdateEnvironment;
}): Promise<EnvironmentRow> {
  const { id, organizationId, data } = params;

  if (data.name !== undefined) {
    const existing = await EnvironmentModel.listForOrganization(organizationId);
    if (existing.some((e) => e.id !== id && e.name === data.name)) {
      throw new ApiError(409, "An environment with this name already exists.");
    }
  }

  const current = await EnvironmentModel.findByIdForOrganization(
    id,
    organizationId,
  );
  if (!current) {
    throw new ApiError(404, "Environment not found");
  }
  if (current.deletingAt) {
    throw new ApiError(409, ENVIRONMENT_BEING_DELETED_MESSAGE);
  }
  if (
    current.kubeconfigServer &&
    data.namespace &&
    data.namespace !== current.namespace
  ) {
    await assertClusterNamespaceIsFree({
      server: current.kubeconfigServer,
      namespace: data.namespace,
    });
  }

  // A rotated credential goes into a new secret; the row is pointed at it and
  // its version bumped in one write, and only then is the old secret removed.
  let rotation: { newSecretId: string; oldSecretId: string } | null = null;
  if (
    data.kubeconfig !== undefined ||
    data.agentRuntimePlatformBaseUrl !== undefined
  ) {
    if (data.agentRuntimePlatformBaseUrl && !current.kubeconfigSecretId) {
      throw new ApiError(400, PLATFORM_URL_NEEDS_OWN_CLUSTER_MESSAGE);
    }
    if (data.kubeconfig !== undefined) {
      const kubeconfig = await validateEnvironmentKubeconfigRotation({
        environment: current,
        kubeconfig: data.kubeconfig,
        namespace:
          data.namespace !== undefined ? data.namespace : current.namespace,
      });
      if (current.kubeconfigSecretId) {
        const secret = await secretManager().createSecret(
          kubeconfigSecretValue(kubeconfig.normalized),
          `environment-kubeconfig-${data.name ?? current.name}`,
        );
        rotation = {
          newSecretId: secret.id,
          oldSecretId: current.kubeconfigSecretId,
        };
      }
    }
  }

  let updated: EnvironmentRow | null;
  try {
    updated = await EnvironmentModel.update({
      id,
      organizationId,
      name: data.name,
      description: data.description,
      namespace: data.namespace,
      networkPolicy: data.networkPolicy,
      validationRegex: data.validationRegex,
      trustedImageRegistries: data.trustedImageRegistries,
      agentRuntimePlatformBaseUrl: data.agentRuntimePlatformBaseUrl,
      rotatedKubeconfigSecretId: rotation?.newSecretId,
      replacedKubeconfigSecretId: rotation?.oldSecretId,
    });
  } catch (error) {
    if (rotation) await removeKubeconfigSecret(rotation.newSecretId);
    throw error;
  }
  if (!updated) {
    // No row changed: the environment is gone, or was marked as being deleted
    // after this request read it.
    if (rotation) await removeKubeconfigSecret(rotation.newSecretId);
    const now = await EnvironmentModel.findByIdForOrganization(
      id,
      organizationId,
    );
    if (!now) throw new ApiError(404, "Environment not found");
    if (now.deletingAt) {
      throw new ApiError(409, ENVIRONMENT_BEING_DELETED_MESSAGE);
    }
    throw new ApiError(
      409,
      "Another request replaced this environment's credential at the same time. Check the environment and try again.",
    );
  }
  if (rotation) {
    await removeKubeconfigSecret(rotation.oldSecretId);
    // Load the new credential into this replica's clients now; the others
    // pick the new version up on their next use or refresh.
    await environmentClusters.forEnvironment(updated);
  }

  // Only touch labels when the caller sent them, so an update that omits the
  // field leaves existing labels alone.
  if (data.labels !== undefined) {
    await EnvironmentLabelModel.syncLabels(id, data.labels);
  }

  reconcileEnvironmentEngine(updated);
  // Agents with their own policy run their engine in their environment's
  // namespace, so a namespace change moves those engines too.
  if (data.namespace !== undefined) {
    reconcileAgentEngines({ organizationId, environmentId: id });
  }
  return updated;
}

/**
 * Gate assigning a catalog item to an environment: it takes a `use` grant on
 * that environment. An environment is a place you deploy into, so the
 * authority to deploy there belongs to the environment rather than to each
 * kind of thing deployed.
 *
 * The organization's Default environment has no row to grant on, and is open
 * to anyone who can create the resource being deployed.
 */
export async function assertCanAssignEnvironment(params: {
  environmentId: string | null | undefined;
  organizationId: string;
  userId: string;
}): Promise<void> {
  const { environmentId, organizationId, userId } = params;

  if (!environmentId) return;

  const environment = await EnvironmentModel.findByIdForOrganization(
    environmentId,
    organizationId,
  );
  if (!environment) {
    throw new ApiError(404, "Environment not found");
  }
  if (environment.deletingAt) {
    throw new ApiError(409, "This environment is being deleted.");
  }
  if (
    !(await canDeployToEnvironment({
      organizationId,
      userId,
      scope: environment.id,
    }))
  ) {
    throw new ApiError(
      403,
      "You do not have permission to assign catalog items to this environment.",
    );
  }
}

/**
 * Enforce a catalog item's governing environment regex against one or more sets
 * of user-supplied config values. No-op when the resolved regex is null. Throws
 * `ApiError(400)` (without echoing the pattern) on the first mismatch.
 */
export async function assertValuesMatchEnvironmentRegex(params: {
  environmentId: string | null | undefined;
  organizationId: string;
  valueSets: Array<Record<string, unknown> | null | undefined>;
}): Promise<void> {
  const { environmentId, organizationId, valueSets } = params;

  const { regex, label } = await resolveEnvironmentValidationRegex({
    environmentId,
    organizationId,
  });
  if (!regex) return;

  try {
    for (const values of valueSets) {
      validateValuesAgainstRegex(values, regex, label);
    }
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }
}

/**
 * Resolve the trusted image registries governing a catalog item, plus a
 * human-readable label for messages. A set `environmentId` resolves to that
 * environment's list; a null/undefined one falls back to the org's default
 * environment (`defaultEnvironmentTrustedImageRegistries`), mirroring
 * `resolveEnvironmentValidationRegex`. A NULL or empty list means "no
 * restriction" (any image allowed).
 */
export async function resolveTrustedImageRegistries(params: {
  environmentId: string | null | undefined;
  organizationId: string;
}): Promise<{ registries: TrustedImageRegistries | null; label: string }> {
  const { environmentId, organizationId } = params;

  if (!environmentId) {
    const organization = await OrganizationModel.getById(organizationId);
    return {
      registries:
        organization?.defaultEnvironmentTrustedImageRegistries ?? null,
      label: organization?.defaultEnvironmentName ?? "Default",
    };
  }

  const environment = await EnvironmentModel.findByIdForOrganization(
    environmentId,
    organizationId,
  );
  return {
    registries: environment?.trustedImageRegistries ?? null,
    label: environment?.name ?? "Default",
  };
}

/**
 * Enforce that a remote MCP server's URL is reachable under its governing
 * environment's network egress policy. No-op for self-hosted servers (their
 * egress is enforced by the real k8s NetworkPolicy on the pod) and for
 * unrestricted / built-in policies. Throws `ApiError(400)` when the policy
 * would block the backend's outbound connection to the server URL.
 *
 * This is the create/edit-time guard, for early feedback in the form. The
 * runtime connection guard in the MCP client enforces the same policy on actual
 * calls, so a grandfathered server is still blocked at call time.
 */
export async function assertRemoteServerUrlAllowedByNetworkPolicy(params: {
  serverType: InternalMcpCatalogServerType;
  serverUrl: string | null | undefined;
  environmentId: string | null | undefined;
  organizationId: string;
}): Promise<void> {
  const verdict = await evaluateRemoteServerUrlAgainstNetworkPolicy(params);
  if (!verdict.allowed) {
    // internal_code lets the frontend attach this to the Server URL field
    // inline instead of a generic toast. Keep in sync with the frontend
    // constant of the same value.
    throw new ApiError(400, verdict.message, "remote_server_url_not_allowed");
  }
}

export async function deleteEnvironment(params: {
  id: string;
  organizationId: string;
  /**
   * Delete an environment with its own cluster even when its workloads could
   * not be removed from that cluster (it is gone or unreachable). They stay
   * there; nothing in the platform refers to them afterwards.
   */
  skipClusterCleanup?: boolean;
}): Promise<void> {
  const { id, organizationId } = params;

  const environment = await EnvironmentModel.findByIdForOrganization(
    id,
    organizationId,
  );
  if (!environment) {
    throw new ApiError(404, "Environment not found");
  }

  // An environment of the platform's own cluster is deleted unless catalog
  // items are assigned to it; its agents move to the default environment.
  if (!environment.kubeconfigSecretId) {
    const outcome = await EnvironmentModel.deleteUnused({
      id,
      organizationId,
      blocking: ["catalogItems"],
    });
    if (outcome === null) throw new ApiError(404, "Environment not found");
    if (outcome !== "deleted") assertUnused(outcome, ["catalogItems"]);
  } else {
    const kubeconfigSecretId = await deleteEnvironmentWithOwnCluster({
      environment,
      skipClusterCleanup: params.skipClusterCleanup ?? false,
    });
    environmentClusters.forget(id);
    if (kubeconfigSecretId) await removeKubeconfigSecret(kubeconfigSecretId);
  }

  // The catalog item of the environment's built-in browser MCP server is
  // a child of the environment and goes with it.
  const playwrightCatalog =
    await PlaywrightRuntimeModel.findCatalogForEnvironment(id);
  if (playwrightCatalog) {
    await InternalMcpCatalogModel.delete(playwrightCatalog.id);
  }

  if (!environment.kubeconfigSecretId) teardownEnvironmentEngine(environment);
  // Its agents are now unbound, so their own engines move to the
  // organization's default namespace.
  reconcileAgentEngines({ organizationId });
}

// === Internal helpers ===

/**
 * Delete an environment that deploys into a cluster of its own.
 *
 * Once the row and its kubeconfig are gone nothing can reach that cluster, so
 * nothing of this installation may be left in it, or still arrive in it:
 *
 * 1. Mark the environment as being deleted, unless something still uses it or
 *    an operation is still writing to its cluster. From the mark on, no
 *    operation writes there: each one records itself first, and a marked
 *    environment refuses the record.
 * 2. Remove what is in the cluster. A failure stops here: the environment
 *    stays marked and keeps its kubeconfig, and the delete can be repeated.
 * 3. Delete the row. Something assigned to it meanwhile stops the delete and
 *    puts the environment back in service.
 *
 * Its agents and their workspaces have to be gone first, where another
 * environment's agents are simply moved to the default environment: their
 * engines and workspaces are in the cluster that is about to become
 * unreachable.
 *
 * Resolves to the kubeconfig secret the deleted row named, for removal; null
 * when another request deleted the environment first.
 */
async function deleteEnvironmentWithOwnCluster(params: {
  environment: EnvironmentRow;
  skipClusterCleanup: boolean;
}): Promise<string | null> {
  const { id, organizationId } = params.environment;
  const blocking: EnvironmentUse[] = ["catalogItems", "agents", "workspaces"];

  const marked = await EnvironmentModel.markDeleting({
    id,
    organizationId,
    blocking,
  });
  if (marked === null) throw new ApiError(404, "Environment not found");
  if (marked.outcome === "in-use") assertUnused(marked.uses, blocking);
  if (marked.outcome === "busy") {
    throw new ApiError(
      409,
      `${marked.writes} operation${
        marked.writes === 1 ? " is" : "s are"
      } still deploying into this environment's cluster. Delete it again in a moment; an operation that stopped without finishing is ignored after ${
        ENVIRONMENT_CLUSTER_WRITE_LIFETIME_MS / 60_000
      } minutes.`,
      ENVIRONMENT_CLUSTER_BUSY_CODE,
    );
  }

  // The environment as it was marked, not as this request first read it: an
  // update in between may have moved it to another namespace.
  const environment = marked.environment;
  try {
    await removeEnvironmentClusterWorkloads(environment);
  } catch (error) {
    if (!params.skipClusterCleanup) {
      logger.warn(
        { err: error, environmentId: id },
        "Could not remove an environment's workloads from its cluster",
      );
      throw new ApiError(
        409,
        `Could not remove this environment's workloads from its cluster: ${
          describeK8sApiError(error) ??
          (error instanceof Error ? error.message : String(error))
        }. Fix access to the cluster and delete it again, or delete it without cleaning the cluster up.`,
        ENVIRONMENT_CLUSTER_CLEANUP_FAILED_CODE,
      );
    }
    logger.warn(
      { err: error, environmentId: id },
      "Deleting an environment whose workloads stay in its cluster",
    );
  }

  const assigned: EnvironmentUse[] = ["catalogItems", "agents"];
  const outcome = await EnvironmentModel.deleteMarked({
    id,
    organizationId,
    blocking: assigned,
  });
  // Another delete of the same environment finished first.
  if (outcome === null) return null;
  if (outcome.outcome === "restored") {
    // The environment is in service again. Bring back what the cleanup
    // removed: its engine, its built-in browser MCP server, and the engines
    // of the agents bound to it. An MCP server assigned meanwhile, whose
    // start was refused, starts on its next install or restart.
    reconcileEnvironmentEngine(environment);
    await reconcilePlaywrightRuntime(environment);
    reconcileAgentEngines({ organizationId });
    assertUnused(outcome.uses, assigned);
  }
  return outcome.kubeconfigSecretId;
}

type EnvironmentUse = keyof Awaited<
  ReturnType<typeof EnvironmentModel.countUses>
>;

/**
 * Refuse a namespace of a cluster the platform deploys into through a
 * kubeconfig when another environment already deploys into it: everything of
 * this installation in such a namespace is removed with its environment.
 */
async function assertClusterNamespaceIsFree(params: {
  server: string;
  namespace: string;
}): Promise<void> {
  if (await EnvironmentModel.findByClusterNamespace(params)) {
    throw new ApiError(
      409,
      `Another environment already deploys into namespace "${params.namespace}" of the cluster at ${params.server}. Use a different namespace.`,
    );
  }
}

/** Refuse to delete an environment that something still uses. */
function assertUnused(
  uses: Awaited<ReturnType<typeof EnvironmentModel.countUses>>,
  blocking: (keyof typeof uses)[],
): never {
  if (blocking.includes("catalogItems") && uses.catalogItems > 0) {
    throw new ApiError(
      409,
      `This environment still has ${uses.catalogItems} catalog item${
        uses.catalogItems === 1 ? "" : "s"
      } assigned. Reassign or remove them before deleting it.`,
    );
  }
  if (blocking.includes("agents") && uses.agents > 0) {
    throw new ApiError(
      409,
      `This environment still has ${uses.agents} agent${
        uses.agents === 1 ? "" : "s"
      } bound to it. Move them to another environment before deleting it.`,
    );
  }
  if (blocking.includes("workspaces") && uses.workspaces > 0) {
    throw new ApiError(
      409,
      `This environment's cluster still holds ${uses.workspaces} Agent Runtime workspace${
        uses.workspaces === 1 ? "" : "s"
      }. Delete them before deleting the environment.`,
    );
  }
  throw new ApiError(
    409,
    "This environment changed while it was being deleted. Try again.",
  );
}

const PLATFORM_URL_NEEDS_OWN_CLUSTER_MESSAGE =
  "The Agent Runtime platform URL applies only to an environment with its own cluster.";

const ENVIRONMENT_BEING_DELETED_MESSAGE =
  "This environment is being deleted and cannot be changed.";

async function removeKubeconfigSecret(secretId: string): Promise<void> {
  try {
    await secretManager().deleteSecret(secretId);
  } catch (error) {
    // Nothing points at it any more; an orphaned secret is harmless.
    logger.warn(
      { err: error, secretId },
      "Failed to delete an environment's kubeconfig secret",
    );
  }
}

/**
 * The resource kinds a partial defaults payload actually names, with their
 * keys typed (`Object.entries` widens them to `string`). A kind that is absent
 * — or present but undefined — is dropped, so only an explicit null clears a
 * kind and everything else is left unchanged.
 */
function entriesOf(
  data: UpdateEnvironmentResourceDefaults,
): Array<[EnvironmentDefaultableResource, string | null]> {
  return Object.entries(data).filter(
    (entry): entry is [EnvironmentDefaultableResource, string | null] =>
      entry[1] !== undefined,
  );
}

/**
 * Resolve the allowlist validation regex governing a catalog item, plus the
 * human-readable label to name in errors. A set `environmentId` resolves to
 * that environment's rule; a null/undefined one falls back to the org's default
 * environment (`defaultEnvironmentValidationRegex`), mirroring how
 * `assertCanAssignEnvironment` treats the implicit default.
 */
async function resolveEnvironmentValidationRegex(params: {
  environmentId: string | null | undefined;
  organizationId: string;
}): Promise<{ regex: string | null; label: string }> {
  const { environmentId, organizationId } = params;

  if (!environmentId) {
    const organization = await OrganizationModel.getById(organizationId);
    return {
      regex: organization?.defaultEnvironmentValidationRegex ?? null,
      label: organization?.defaultEnvironmentName ?? "Default",
    };
  }

  const environment = await EnvironmentModel.findByIdForOrganization(
    environmentId,
    organizationId,
  );
  return {
    regex: environment?.validationRegex ?? null,
    label: environment?.name ?? "Default",
  };
}

/**
 * Whether the caller may deploy into one environment, or into every one.
 *
 * Deploying is `use` on the environment, and only a stored grant confers it.
 * No role action stands in for it: `environment:read` is held by every custom
 * role, and reading it as `use` would open every restricted environment.
 */
async function canDeployToEnvironment(params: {
  organizationId: string;
  userId: string;
  scope: string;
}): Promise<boolean> {
  const required = {
    organizationId: params.organizationId,
    resource: "environment" as const,
    scope: params.scope,
    action: "use" as const,
  };
  const { grants } = await ResourcePermissions.getEffective({
    ...required,
    userId: params.userId,
  });
  return hasScopedPermission({ grants, required });
}
