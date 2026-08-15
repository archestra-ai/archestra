// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { createHash } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import type pino from "pino";
import { LRUCacheManager } from "@/cache-manager";
import type { P4ShimTarget } from "@/k8s/p4-shim-runtime/manager";
import { p4ShimRuntimeManager } from "@/k8s/p4-shim-runtime/manager";
import { resolveConnectorCredentialVersion } from "@/knowledge-base/connector-credentials";
import logger from "@/logging";
import ConnectorRunModel from "@/models/connector-run";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import {
  type ConnectorIdentity,
  type KnowledgeBaseConnector,
  PerforceConfigSchema,
} from "@/types";
import {
  deriveP4WireAddress,
  type P4WireAddress,
  p4PortCandidates,
  p4ServerScope,
} from "./p4-endpoint";
import { P4ShimClient } from "./p4-shim-client";

/**
 * Glue between Perforce permission sync and the p4 shim runtime.
 *
 * **One shim per connector.** The scope is the connector id, so a shim's
 * egress policy names exactly one Perforce server and its credentials never
 * transit another connector's pod. Nothing here reads across connectors.
 *
 * **A settings change retires the shim.** Every reconcile carries a
 * fingerprint of the connector's identity-affecting settings — server URL,
 * wire-address override, admin user, and the version of its stored
 * credentials. A change to any of them rolls the pod (fresh `/work`: no `p4`
 * binary, no login ticket, no trust entry), rotates the shim's bearer token,
 * and invalidates the cached endpoint below. No secret material is digested
 * into the fingerprint.
 *
 * **The connector row decides whether a shim exists at all.**
 * {@link reconcileP4ShimForConnector} is called from every surface that can
 * change the answer, so a pod is created when a connector starts syncing
 * Perforce permissions and removed the moment it stops — deleted, disabled, or
 * switched to another visibility. Nothing about it is driven by how recently a
 * pass ran.
 */

/**
 * Ensure the connector's shim is running against its current settings, verify
 * its wire address, and return a client bound to it alongside the address it
 * was verified against.
 */
export async function getP4ShimConnection(params: {
  identity: ConnectorIdentity;
  serverUrl: string;
  /** Optional wire-address override; derived from `serverUrl` when absent. */
  p4Port?: string;
  username: string;
  password: string;
  log: pino.Logger;
}): Promise<{ client: P4ShimClient; address: P4WireAddress }> {
  const address = deriveP4WireAddress(params);
  if (!address) {
    throw new Error(
      "Could not determine the Perforce wire address: the connector's Server URL has no host, and no p4Port override is set",
    );
  }
  const run = params.identity.run;
  const configFingerprint = p4ShimConfigFingerprint(params);
  const target = await p4ShimRuntimeManager.ensure({
    connectorId: params.identity.connectorId,
    organizationId: params.identity.organizationId,
    server: address,
    configFingerprint,
    configIsCurrent: () =>
      storedFingerprintMatches({
        connectorId: params.identity.connectorId,
        configFingerprint,
      }),
    ...(run ? { callerOwnsRun: () => runIsStillOwned(run) } : {}),
  });
  const p4port = await resolveP4Port({
    target,
    configFingerprint,
    address,
    candidates: p4PortCandidates(params),
    username: params.username,
    log: params.log,
  });
  return {
    address,
    client: new P4ShimClient({
      target,
      p4port,
      username: params.username,
      password: params.password,
      log: params.log,
    }),
  };
}

/**
 * Bring the connector's shim into line with its row: one running pod while the
 * connector syncs permissions through Perforce, and no shim resources at all
 * otherwise — deleted, disabled, switched to another visibility, no longer a
 * Perforce connector, or missing the settings a pod would be built from.
 *
 * Called from every write surface that can change that answer, and awaited
 * there, so in the ordinary case the pod is created (or gone, with its token
 * and its egress rule) before the request that caused it returns. It issues a
 * handful of Kubernetes calls and waits for no pod, so it costs the request
 * milliseconds rather than the minutes a scheduling-and-image-pull wait would.
 *
 * Never throws. The connector row is already committed by the time this runs,
 * so failing the caller would report a change that did happen as one that did
 * not; the sweep in `p4-shim-reconcile-handler` converges anything a cluster
 * outage leaves behind.
 */
export async function reconcileP4ShimForConnector(
  connectorId: string,
): Promise<void> {
  if (!p4ShimRuntimeManager.isEnabled()) return;
  try {
    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
    // A connector of another type never had a shim, and this runs on every
    // connector write in the deployment — so answering it from the row costs
    // nothing, where the teardown below would cost four 404ing deletes each
    // time. A connector that is gone entirely still falls through: its type is
    // no longer readable, and its shim is exactly what needs removing.
    if (connector && connector.connectorType !== "perforce") return;
    const desired = connector ? await desiredShimSpec(connector) : null;
    if (desired) {
      await p4ShimRuntimeManager.apply(desired);
    } else {
      await p4ShimRuntimeManager.teardown(connectorId);
    }
  } catch (error) {
    logger.warn(
      { err: error, connectorId },
      "[P4Shim] could not reconcile the connector's shim; the periodic sweep will retry",
    );
  }
}

/** Remove a connector's shim outright — its pod, Service, token and policy. */
export async function teardownP4Shim(connectorId: string): Promise<void> {
  if (!p4ShimRuntimeManager.isEnabled()) return;
  await p4ShimRuntimeManager.teardown(connectorId);
}

// ===== Internal helpers =====

/**
 * The shim the connector's row calls for, or null when it calls for none.
 *
 * The whole want/don't-want decision, in one place, read from the row rather
 * than inferred from what the cluster happens to hold: a shim keeps a tenant's
 * bearer token and an egress rule to their Perforce server, so "does this
 * connector still sync Perforce permissions?" is the only question that may
 * decide whether one exists.
 *
 * A connector missing the settings a pod is built from — no admin user, or a
 * Server URL with no derivable wire address — wants none either. There is no
 * server to scope its egress to, and a pod that cannot be given one would be
 * a token and a policy with nothing behind them.
 */
async function desiredShimSpec(connector: KnowledgeBaseConnector) {
  if (
    connector.connectorType !== "perforce" ||
    connector.visibility !== "auto-sync-permissions" ||
    !connector.enabled
  ) {
    return null;
  }
  const stored = PerforceConfigSchema.safeParse(connector.config);
  if (!stored.success || !stored.data.adminUsername) return null;
  const server = deriveP4WireAddress(stored.data);
  if (!server) return null;

  const configFingerprint = p4ShimConfigFingerprint({
    identity: {
      secretId: connector.secretId,
      credentialVersion: await resolveConnectorCredentialVersion(
        connector.secretId,
      ),
    },
    serverUrl: stored.data.serverUrl,
    p4Port: stored.data.p4Port,
    username: stored.data.adminUsername,
  });
  return {
    connectorId: connector.id,
    organizationId: connector.organizationId,
    server,
    configFingerprint,
    configIsCurrent: () =>
      storedFingerprintMatches({
        connectorId: connector.id,
        configFingerprint,
      }),
  };
}

/**
 * Digest of everything about the connector that the pod's behaviour or reach
 * depends on. The credentials are represented by their version marker (the
 * secret row's `updatedAt`), so a rotation retires the pod without a password
 * hash ever reaching a Kubernetes annotation, where it would be readable by
 * anyone who can read Deployments.
 */
function p4ShimConfigFingerprint(params: {
  identity: Pick<ConnectorIdentity, "secretId" | "credentialVersion">;
  serverUrl: string;
  p4Port?: string;
  username: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        params.serverUrl,
        params.p4Port ?? "",
        params.username,
        params.identity.secretId ?? "",
        params.identity.credentialVersion,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

/**
 * Whether the connector's settings, read now, still digest to `fingerprint`.
 *
 * The fence the shim manager applies before it writes. A permission pass
 * captures the connector row and its credentials once and replays them for its
 * whole duration, so by the time a late hook reconciles the shim the admin may
 * have changed the server, the admin user, or the password. Reconciling the
 * captured settings then rolls the pod back onto the configuration the edit
 * retired — which is why this reads the row and the secret's version afresh
 * rather than deriving anything from the pass's own copy.
 *
 * A connector that has been deleted, or is no longer Perforce, matches
 * nothing: there is no current configuration to reconcile.
 */
async function storedFingerprintMatches(params: {
  connectorId: string;
  configFingerprint: string;
}): Promise<boolean> {
  const connector = await KnowledgeBaseConnectorModel.findById(
    params.connectorId,
  );
  if (!connector) return false;
  const stored = PerforceConfigSchema.safeParse(connector.config);
  if (!stored.success || !stored.data.adminUsername) return false;
  const current = p4ShimConfigFingerprint({
    identity: {
      secretId: connector.secretId,
      credentialVersion: await resolveConnectorCredentialVersion(
        connector.secretId,
      ),
    },
    serverUrl: stored.data.serverUrl,
    p4Port: stored.data.p4Port,
    username: stored.data.adminUsername,
  });
  return current === params.configFingerprint;
}

/**
 * Whether the run a caller is acting under is still theirs.
 *
 * Read fresh, never from the pass's own copy: the point is to notice a
 * reclaim that happened while this worker was not running.
 */
async function runIsStillOwned(run: {
  runId: string;
  epoch: number;
}): Promise<boolean> {
  return await ConnectorRunModel.isOwnedRun(run);
}

/**
 * Verified wire endpoints, keyed by the configuration that produced them.
 * Short-lived so a server that moves between plain and SSL heals on its own,
 * and fingerprint-keyed so an edited wire address can never be served the
 * endpoint the previous settings resolved to.
 */
const resolvedP4Ports = new LRUCacheManager<string>({
  maxSize: 256,
  defaultTtl: 10 * TimeInMs.Minute,
});

/**
 * Probe the candidate transports in order and return the first that answers.
 * Only successes are cached, so a server that comes back up (or gets its
 * certificate) is picked up on the next pass instead of after a TTL.
 */
async function resolveP4Port(params: {
  target: P4ShimTarget;
  configFingerprint: string;
  address: P4WireAddress;
  candidates: string[];
  username: string;
  log: pino.Logger;
}): Promise<string> {
  const cacheKey = `${params.configFingerprint}|${p4ServerScope(params.address)}`;
  const cached = resolvedP4Ports.get(cacheKey);
  if (cached) return cached;

  const failures: string[] = [];
  for (const p4port of params.candidates) {
    const probe = await new P4ShimClient({
      target: params.target,
      p4port,
      username: params.username,
      // Reachability only — the probe is an unauthenticated `p4 info`.
      password: "",
      log: params.log,
    }).probe();
    if (probe.reachable) {
      params.log.info(
        { p4port, candidates: params.candidates },
        "Verified Perforce wire endpoint",
      );
      resolvedP4Ports.set(cacheKey, p4port);
      return p4port;
    }
    failures.push(`${p4port}: ${probe.error}`);
  }
  throw new Error(
    `No Perforce server answered at the connector's wire address. Tried ${failures.join(
      "; ",
    )}. Set the connector's P4 Port if the Perforce server's wire address differs from its REST Server URL host.`,
  );
}
