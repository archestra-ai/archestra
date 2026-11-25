import { isServiceAccountUserId } from "@/auth/service-account-user-id";
import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import MemberModel from "@/models/member";
import OwnedResourceModel, {
  type OwnedResourceKind,
} from "@/models/owned-resource";
import UserModel from "@/models/user";
import { reportAuditWriteFailure } from "@/observability/metrics/audit";
import { handOffAgentOwnership } from "./agent-ownership";
import { handOffResourceOwnership } from "./resource-ownership";

/**
 * Give a departing member's shared resources (agents, MCP gateways, skills,
 * plugins, MCP registry entries, apps, remote agents) to someone who stays, so
 * the teams using them keep an owner who can manage them. Resources only the
 * departing member could reach are left alone; they are personal and are
 * deleted with the member.
 *
 * The new owner is `recipientId` (the admin removing the member) when that is
 * an active member other than the departing one, and otherwise the
 * organization's longest-standing active admin. The departing member keeps
 * their own grant on each resource, so restoring a deactivated user gives back
 * their access.
 *
 * Never throws: a resource that cannot change hands keeps its owner and is
 * logged, and the rest still move.
 */
export async function handOffSharedResources(params: {
  userId: string;
  organizationId: string;
  recipientId?: string | null;
}): Promise<{ ownerId: string | null; handedOff: number; skipped: number }> {
  const { userId, organizationId } = params;
  try {
    const resources = await OwnedResourceModel.findSharedByOwner({
      userId,
      organizationId,
    });
    if (resources.length === 0)
      return { ownerId: null, handedOff: 0, skipped: 0 };

    const explicit =
      params.recipientId &&
      (await isEligibleRecipient({
        candidateId: params.recipientId,
        userId,
        organizationId,
      }))
        ? params.recipientId
        : null;
    const ownerId =
      explicit ??
      (await MemberModel.findLongestStandingAdmin({
        organizationId,
        excludeUserId: userId,
      }));
    if (!ownerId) {
      logger.warn(
        { userId, organizationId, count: resources.length },
        "[owned-resource-handoff] no admin left to receive shared resources",
      );
      return { ownerId: null, handedOff: 0, skipped: resources.length };
    }
    const actor = explicit ? await UserModel.getById(explicit) : null;

    let handedOff = 0;
    for (const resource of resources) {
      try {
        if (resource.kind === "agent" || resource.kind === "mcpGateway")
          await handOffAgentOwnership({
            agentId: resource.id,
            ownerId,
            organizationId,
          });
        else
          await handOffResourceOwnership({
            kind: resource.kind,
            id: resource.id,
            ownerId,
            organizationId,
          });
        handedOff++;
      } catch (err) {
        logger.warn(
          { err, userId, organizationId, ownerId, ...resource },
          "[owned-resource-handoff] resource kept its owner",
        );
        continue;
      }
      await writeAuditRow({
        organizationId,
        resource,
        previousOwnerId: userId,
        ownerId,
        actor,
      });
    }
    logger.info(
      { userId, organizationId, ownerId, handedOff, total: resources.length },
      "[owned-resource-handoff] handed off shared resources",
    );
    return { ownerId, handedOff, skipped: resources.length - handedOff };
  } catch (err) {
    logger.error(
      { err, userId, organizationId },
      "[owned-resource-handoff] failed to hand off shared resources",
    );
    return { ownerId: null, handedOff: 0, skipped: 0 };
  }
}

// ===================================================================
// Internal helpers
// ===================================================================

async function isEligibleRecipient(params: {
  candidateId: string;
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  const { candidateId, userId, organizationId } = params;
  if (candidateId === userId || isServiceAccountUserId(candidateId))
    return false;
  if (!(await MemberModel.getByUserId(candidateId, organizationId)))
    return false;
  return !(await UserModel.getSoftDeleted(candidateId));
}

async function writeAuditRow(params: {
  organizationId: string;
  resource: { kind: OwnedResourceKind; id: string };
  previousOwnerId: string;
  ownerId: string;
  actor: { id: string; name: string | null; email: string } | null;
}): Promise<void> {
  const resourceType = AUDIT_RESOURCE_TYPES[params.resource.kind];
  try {
    await AuditLogModel.create({
      organizationId: params.organizationId,
      actorId: params.actor?.id ?? null,
      actorType: params.actor ? "user" : "system",
      actorName: params.actor ? params.actor.name : "Member removal",
      actorEmail: params.actor?.email ?? null,
      action: `${resourceType}.updated`,
      outcome: "success",
      resourceType,
      resourceId: params.resource.id,
      before: { authorId: params.previousOwnerId },
      after: { authorId: params.ownerId },
      occurredAt: new Date(),
    });
  } catch (err) {
    logger.error(
      { err, ...params.resource },
      "[owned-resource-handoff] failed to write audit row",
    );
    reportAuditWriteFailure({ source: "auth", resourceType });
  }
}

/** Matches the resource types the transfer-ownership routes audit under. */
const AUDIT_RESOURCE_TYPES = {
  agent: "agent",
  mcpGateway: "agent",
  remoteAgent: "agent",
  skill: "skill",
  plugin: "plugin",
  catalog: "internalMcpCatalog",
  app: "app",
} as const satisfies Record<OwnedResourceKind, string>;
