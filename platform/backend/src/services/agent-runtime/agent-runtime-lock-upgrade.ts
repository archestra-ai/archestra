// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { setTimeout as sleep } from "node:timers/promises";
import {
  agentRuntimePermissionScope,
  PopularAgentIdSchema,
  type ResourcePermissionGrant,
} from "@archestra/shared";
import type { Transaction } from "@/database";
import logger from "@/logging";
import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import StartupMigrationModel from "@/models/startup-migration";

/** Run once per database, including when several replicas start together. */
export async function ensureAgentRuntimeLockUpgrade(): Promise<void> {
  let waiting = false;
  while (
    !(await StartupMigrationModel.tryRun({
      id: "agent-runtime-locks-to-permissions-v1",
      migrate: upgradeAgentRuntimeLocks,
    }))
  ) {
    if (!waiting) {
      logger.info(
        "[AgentRuntime] Waiting for the runtime lock upgrade on another replica",
      );
      waiting = true;
    }
    await sleep(1000);
  }
}

/**
 * Turn locked runtimes into permissions. A locked runtime's settings could be
 * changed only by people who manage organization settings, while the roles
 * that held `agent:configure-runtime` could change every other runtime's.
 * Migration 0640 gave those roles configure on every runtime; in an
 * organization that locked a runtime this narrows them to use everywhere,
 * plus configure on each runtime that wasn't locked. Admin and Platform
 * Admin keep full access. The settings' retired `locked` flags are cleared.
 *
 * Runs after the schema migrations, since it reads the grants 0640 wrote, and
 * in the startup transaction, so the grants and the cleared flags commit
 * together.
 *
 * @public — exercised directly by its upgrade test
 */
export async function upgradeAgentRuntimeLocks(tx: Transaction): Promise<void> {
  for (const {
    organizationId,
    locked,
    templateIds,
  } of await AgentRuntimeTemplateModel.takeRetiredLocks(tx)) {
    if (locked.size === 0) continue;
    const everywhere = {
      organizationId,
      resource: "agentRuntime" as const,
      scope: "*",
    };
    const policy = await ResourcePermissionPolicyModel.findForUpdate({
      tx,
      ...everywhere,
    });
    const configurers = (policy?.grants ?? []).filter(
      (grant) =>
        grant.subject.type === "role" &&
        !ADMIN_ROLES.has(grant.subject.id) &&
        grant.actions.includes("configure"),
    );
    if (!policy || configurers.length === 0) continue;
    await ResourcePermissionPolicyModel.upsertGrants({
      tx,
      ...everywhere,
      grants: policy.grants.map((grant) =>
        configurers.includes(grant) ? { ...grant, actions: USE } : grant,
      ),
    });
    const unlocked = [
      ...PopularAgentIdSchema.options
        .filter((id) => !locked.has(id))
        .map((id) => agentRuntimePermissionScope({ kind: "built-in", id })),
      ...templateIds.filter((id) => !locked.has(id)),
    ];
    for (const scope of unlocked) {
      const key = { organizationId, resource: "agentRuntime" as const, scope };
      const existing = await ResourcePermissionPolicyModel.findForUpdate({
        tx,
        ...key,
      });
      await ResourcePermissionPolicyModel.upsertGrants({
        tx,
        ...key,
        grants: [
          ...(existing?.grants ?? []).filter(
            (grant) => !configurers.some((role) => sameSubject(role, grant)),
          ),
          ...configurers.map((role) => ({
            subject: role.subject,
            actions: CONFIGURE,
          })),
        ],
      });
    }
    logger.info(
      { organizationId, locked: locked.size, roles: configurers.length },
      "[AgentRuntime] Turned locked runtimes into runtime permissions",
    );
  }
}

// ===================================================================
// Internal
// ===================================================================

const ADMIN_ROLES = new Set(["admin", "platform_admin"]);
const USE: ResourcePermissionGrant["actions"] = ["read", "use"];
const CONFIGURE: ResourcePermissionGrant["actions"] = [
  "read",
  "use",
  "configure",
];

function sameSubject(a: ResourcePermissionGrant, b: ResourcePermissionGrant) {
  return a.subject.type === b.subject.type && a.subject.id === b.subject.id;
}
