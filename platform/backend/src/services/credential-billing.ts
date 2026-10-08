import { userHasPermission } from "@/auth/utils";
import LimitModel from "@/models/limit";
import TeamModel from "@/models/team";
import { getTeamForOrg } from "@/services/team-authorization";
import {
  ApiError,
  type CredentialBillingTeam,
  type CredentialSpendCap,
  type CredentialSpendCapInput,
} from "@/types";

type BilledEntityType = "virtual_key" | "llm_oauth_client";

/**
 * Who pays for a virtual key or LLM OAuth client: an optional billing team,
 * and an optional spend cap stored as a `token_cost` limit on the credential.
 *
 * Billing a team charges that team's budget and lifts the caller's personal
 * limit, so only cost managers (`llmLimit:update`) and the team's own admins
 * may pick a team. A new cap only restricts spend, so anyone who can edit the
 * credential may add one; changing or removing an existing cap needs the
 * matching `llmLimit` permission, so a key owner cannot undo a cap an admin set.
 */
class CredentialBillingService {
  /**
   * Validate a requested billing team change. Unchanged values pass without a
   * check, so editing other fields of a credential billed to a team the
   * caller cannot pick still works.
   */
  async assertCanSetBillingTeam(params: {
    organizationId: string;
    userId: string;
    teamId: string | null | undefined;
    currentTeamId?: string | null;
  }): Promise<void> {
    const { teamId } = params;
    if (teamId === undefined || teamId === (params.currentTeamId ?? null)) {
      return;
    }
    if (teamId === null) {
      // Moving spend off a team's budget back to the caller's is a cost
      // decision too: the caller may not be bound by that team's limit.
      if (await this.isCostManager(params)) return;
      if (
        params.currentTeamId &&
        (await TeamModel.isUserTeamAdmin(params.currentTeamId, params.userId))
      ) {
        return;
      }
      throw new ApiError(
        403,
        "Only cost managers and the team's admins can stop billing a team.",
      );
    }
    const team = await getTeamForOrg({
      teamId,
      organizationId: params.organizationId,
    });
    if (!team) {
      throw new ApiError(400, "Billing team not found.");
    }
    if (await this.isCostManager(params)) return;
    if (await TeamModel.isUserTeamAdmin(teamId, params.userId)) return;
    throw new ApiError(
      403,
      "You can only bill teams you are an admin of. Ask a cost manager to bill another team.",
    );
  }

  /** Validate a requested spend cap change against the credential's current cap. */
  async assertCanSetSpendCap(params: {
    organizationId: string;
    userId: string;
    cap: CredentialSpendCapInput | null | undefined;
    current: CredentialSpendCap | null;
  }): Promise<void> {
    const { cap, current } = params;
    if (cap === undefined) return;
    if (!current) {
      // Adding a cap only lowers what the credential can spend.
      return;
    }
    if (
      cap &&
      cap.limitValue === current.limitValue &&
      cap.cleanupInterval === current.cleanupInterval
    ) {
      return;
    }
    const action = cap ? "update" : "delete";
    if (
      await userHasPermission(
        params.userId,
        params.organizationId,
        "llmLimit",
        action,
      )
    ) {
      return;
    }
    throw new ApiError(
      403,
      "Changing an existing spend cap needs permission to manage limits.",
    );
  }

  async applySpendCap(params: {
    entityType: BilledEntityType;
    entityId: string;
    cap: CredentialSpendCapInput | null | undefined;
  }): Promise<void> {
    if (params.cap === undefined) return;
    await LimitModel.setSpendCap({
      entityType: params.entityType,
      entityId: params.entityId,
      cap: params.cap,
    });
  }

  async getSpendCap(params: {
    entityType: BilledEntityType;
    entityId: string;
  }): Promise<CredentialSpendCap | null> {
    const caps = await LimitModel.findSpendCaps({
      entityType: params.entityType,
      entityIds: [params.entityId],
    });
    return caps.get(params.entityId) ?? null;
  }

  /** Billing teams and spend caps for a page of credentials, in two queries. */
  async loadMany(params: {
    entityType: BilledEntityType;
    credentials: Array<{ id: string; billingTeamId: string | null }>;
  }): Promise<
    Map<
      string,
      {
        billingTeam: CredentialBillingTeam | null;
        spendCap: CredentialSpendCap | null;
      }
    >
  > {
    const teamIds = [
      ...new Set(
        params.credentials.flatMap((c) =>
          c.billingTeamId ? [c.billingTeamId] : [],
        ),
      ),
    ];
    const [teams, caps] = await Promise.all([
      teamIds.length > 0 ? TeamModel.findByIds(teamIds) : [],
      LimitModel.findSpendCaps({
        entityType: params.entityType,
        entityIds: params.credentials.map((c) => c.id),
      }),
    ]);
    const teamsById = new Map(teams.map((team) => [team.id, team]));
    return new Map(
      params.credentials.map((credential) => {
        const team = credential.billingTeamId
          ? teamsById.get(credential.billingTeamId)
          : undefined;
        return [
          credential.id,
          {
            billingTeam: team ? { id: team.id, name: team.name } : null,
            spendCap: caps.get(credential.id) ?? null,
          },
        ];
      }),
    );
  }

  private isCostManager(params: {
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    return userHasPermission(
      params.userId,
      params.organizationId,
      "llmLimit",
      "update",
    );
  }
}

export const credentialBilling = new CredentialBillingService();
