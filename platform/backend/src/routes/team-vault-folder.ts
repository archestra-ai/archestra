import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import config from "@/config";
import { TeamModel } from "@/models";
import TeamVaultFolderModel from "@/models/team-vault-folder";
import { teamVaultSecretManager } from "@/team-vault-secret-manager";
import {
  ApiError,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectTeamVaultFolderSchema,
  SetTeamVaultFolderBodySchema,
} from "@/types";

// Response schemas
const VaultFolderConnectivityResponseSchema = z.object({
  connected: z.boolean(),
  secretCount: z.number(),
  error: z.string().optional(),
});

const VaultSecretListItemSchema = z.object({
  name: z.string(),
  path: z.string(),
});

const teamVaultFolderRoutes: FastifyPluginAsyncZod = async (fastify) => {
  /**
   * Get team's Vault folder configuration
   */
  fastify.get(
    "/api/teams/:teamId/vault-folder",
    {
      schema: {
        operationId: RouteId.GetTeamVaultFolder,
        description: "Get a team's Vault folder configuration",
        tags: ["Teams", "Vault"],
        params: z.object({
          teamId: z.string(),
        }),
        response: constructResponseSchema(
          SelectTeamVaultFolderSchema.nullable(),
        ),
      },
    },
    async ({ params: { teamId }, organizationId, user }, reply) => {
      // Verify enterprise license
      if (!config.enterpriseLicenseActivated) {
        throw new ApiError(
          403,
          "Team Vault folders is an enterprise feature. Please contact sales@archestra.ai to enable it.",
        );
      }

      // Verify Vault is configured
      if (!teamVaultSecretManager) {
        throw new ApiError(
          400,
          "Vault secrets manager is not configured. Set ARCHESTRA_SECRETS_MANAGER=Vault to enable this feature.",
        );
      }

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user has access (org admin or team admin)
      const hasAccess = await TeamVaultFolderModel.userHasAccess(
        user.id,
        teamId,
        false, // Let the model check for org admin via team membership
      );

      if (!hasAccess) {
        throw new ApiError(
          403,
          "Only team admins can view Vault folder configuration",
        );
      }

      const folder = await TeamVaultFolderModel.findByTeamId(teamId);
      return reply.send(folder);
    },
  );

  /**
   * Set or update team's Vault folder path
   */
  fastify.post(
    "/api/teams/:teamId/vault-folder",
    {
      schema: {
        operationId: RouteId.SetTeamVaultFolder,
        description: "Set or update a team's Vault folder path",
        tags: ["Teams", "Vault"],
        params: z.object({
          teamId: z.string(),
        }),
        body: SetTeamVaultFolderBodySchema,
        response: constructResponseSchema(SelectTeamVaultFolderSchema),
      },
    },
    async (
      { params: { teamId }, body: { vaultPath }, organizationId, user },
      reply,
    ) => {
      // Verify enterprise license
      if (!config.enterpriseLicenseActivated) {
        throw new ApiError(
          403,
          "Team Vault folders is an enterprise feature. Please contact sales@archestra.ai to enable it.",
        );
      }

      // Verify Vault is configured
      if (!teamVaultSecretManager) {
        throw new ApiError(
          400,
          "Vault secrets manager is not configured. Set ARCHESTRA_SECRETS_MANAGER=Vault to enable this feature.",
        );
      }

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user has access (org admin or team admin)
      const hasAccess = await TeamVaultFolderModel.userHasAccess(
        user.id,
        teamId,
        false,
      );

      if (!hasAccess) {
        throw new ApiError(
          403,
          "Only team admins can configure Vault folder settings",
        );
      }

      // Validate the Vault path format (basic validation)
      if (vaultPath.includes("..") || vaultPath.startsWith("/")) {
        throw new ApiError(
          400,
          "Invalid Vault path. Path cannot contain '..' or start with '/'",
        );
      }

      const folder = await TeamVaultFolderModel.upsert(teamId, vaultPath);
      return reply.send(folder);
    },
  );

  /**
   * Delete team's Vault folder mapping
   */
  fastify.delete(
    "/api/teams/:teamId/vault-folder",
    {
      schema: {
        operationId: RouteId.DeleteTeamVaultFolder,
        description: "Delete a team's Vault folder mapping",
        tags: ["Teams", "Vault"],
        params: z.object({
          teamId: z.string(),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { teamId }, organizationId, user }, reply) => {
      // Verify enterprise license
      if (!config.enterpriseLicenseActivated) {
        throw new ApiError(
          403,
          "Team Vault folders is an enterprise feature. Please contact sales@archestra.ai to enable it.",
        );
      }

      // Verify Vault is configured
      if (!teamVaultSecretManager) {
        throw new ApiError(
          400,
          "Vault secrets manager is not configured. Set ARCHESTRA_SECRETS_MANAGER=Vault to enable this feature.",
        );
      }

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user has access (org admin or team admin)
      const hasAccess = await TeamVaultFolderModel.userHasAccess(
        user.id,
        teamId,
        false,
      );

      if (!hasAccess) {
        throw new ApiError(
          403,
          "Only team admins can delete Vault folder configuration",
        );
      }

      const success = await TeamVaultFolderModel.delete(teamId);

      if (!success) {
        throw new ApiError(404, "Vault folder configuration not found");
      }

      return reply.send({ success: true });
    },
  );

  /**
   * Check connectivity to team's Vault folder
   */
  fastify.post(
    "/api/teams/:teamId/vault-folder/check-connectivity",
    {
      schema: {
        operationId: RouteId.CheckTeamVaultFolderConnectivity,
        description: "Check connectivity to a team's Vault folder",
        tags: ["Teams", "Vault"],
        params: z.object({
          teamId: z.string(),
        }),
        response: constructResponseSchema(
          VaultFolderConnectivityResponseSchema,
        ),
      },
    },
    async ({ params: { teamId }, organizationId, user }, reply) => {
      // Verify enterprise license
      if (!config.enterpriseLicenseActivated) {
        throw new ApiError(
          403,
          "Team Vault folders is an enterprise feature. Please contact sales@archestra.ai to enable it.",
        );
      }

      // Verify Vault is configured
      if (!teamVaultSecretManager) {
        throw new ApiError(
          400,
          "Vault secrets manager is not configured. Set ARCHESTRA_SECRETS_MANAGER=Vault to enable this feature.",
        );
      }

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user has access (org admin or team admin)
      const hasAccess = await TeamVaultFolderModel.userHasAccess(
        user.id,
        teamId,
        false,
      );

      if (!hasAccess) {
        throw new ApiError(
          403,
          "Only team admins can check Vault folder connectivity",
        );
      }

      // Get the team's Vault folder
      const folder = await TeamVaultFolderModel.findByTeamId(teamId);
      if (!folder) {
        throw new ApiError(
          400,
          "No Vault folder configured for this team. Set a Vault path first.",
        );
      }

      const result = await teamVaultSecretManager.checkFolderConnectivity(
        folder.vaultPath,
      );

      return reply.send(result);
    },
  );

  /**
   * List secrets in team's Vault folder
   */
  fastify.get(
    "/api/teams/:teamId/vault-folder/secrets",
    {
      schema: {
        operationId: RouteId.ListTeamVaultFolderSecrets,
        description: "List secrets available in a team's Vault folder",
        tags: ["Teams", "Vault"],
        params: z.object({
          teamId: z.string(),
        }),
        response: constructResponseSchema(z.array(VaultSecretListItemSchema)),
      },
    },
    async ({ params: { teamId }, organizationId, user }, reply) => {
      // Verify enterprise license
      if (!config.enterpriseLicenseActivated) {
        throw new ApiError(
          403,
          "Team Vault folders is an enterprise feature. Please contact sales@archestra.ai to enable it.",
        );
      }

      // Verify Vault is configured
      if (!teamVaultSecretManager) {
        throw new ApiError(
          400,
          "Vault secrets manager is not configured. Set ARCHESTRA_SECRETS_MANAGER=Vault to enable this feature.",
        );
      }

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user has access (org admin or team admin)
      const hasAccess = await TeamVaultFolderModel.userHasAccess(
        user.id,
        teamId,
        false,
      );

      if (!hasAccess) {
        throw new ApiError(
          403,
          "Only team admins can list Vault folder secrets",
        );
      }

      // Get the team's Vault folder
      const folder = await TeamVaultFolderModel.findByTeamId(teamId);
      if (!folder) {
        throw new ApiError(
          400,
          "No Vault folder configured for this team. Set a Vault path first.",
        );
      }

      const secrets = await teamVaultSecretManager.listSecretsInFolder(
        folder.vaultPath,
      );

      return reply.send(secrets);
    },
  );
};

export default teamVaultFolderRoutes;
