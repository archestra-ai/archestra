import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import { TeamModel } from "@/models";
import TeamVaultFolderModel from "@/models/team-vault-folder.ee";
import { assertByosEnabled } from "@/secretsmanager";
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

const VaultSecretKeysResponseSchema = z.object({
  keys: z.array(z.string()),
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
    async (request, reply) => {
      const {
        params: { teamId },
        organizationId,
        user,
        headers,
      } = request;
      assertByosEnabled();

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user is team admin
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );

      await TeamModel.checkTeamAccess({ userId: user.id, teamId, isTeamAdmin });

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
    async (request, reply) => {
      const {
        params: { teamId },
        body: { vaultPath },
        organizationId,
        user,
        headers,
      } = request;
      assertByosEnabled();

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user is team admin
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );

      await TeamModel.checkTeamAccess({ userId: user.id, teamId, isTeamAdmin });

      // Validate the Vault path format (basic validation)
      if (
        vaultPath.includes("..") ||
        vaultPath.startsWith("/") ||
        vaultPath.endsWith("/")
      ) {
        throw new ApiError(
          400,
          "Invalid Vault path. Path cannot contain '..', start with '/', or end with '/'",
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
    async (request, reply) => {
      const {
        params: { teamId },
        organizationId,
        user,
        headers,
      } = request;
      assertByosEnabled();

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user is team admin
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );

      await TeamModel.checkTeamAccess({ userId: user.id, teamId, isTeamAdmin });

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
        body: z
          .object({
            vaultPath: z.string().optional(),
          })
          .optional(),
        response: constructResponseSchema(
          VaultFolderConnectivityResponseSchema,
        ),
      },
    },
    async (request, reply) => {
      const {
        params: { teamId },
        body,
        organizationId,
        user,
        headers,
      } = request;
      const manager = assertByosEnabled();

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user is team admin
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );

      await TeamModel.checkTeamAccess({ userId: user.id, teamId, isTeamAdmin });

      // Use provided vaultPath or fall back to saved folder
      let pathToTest = body?.vaultPath?.trim();

      if (!pathToTest) {
        // Get the team's Vault folder
        const folder = await TeamVaultFolderModel.findByTeamId(teamId);
        if (!folder) {
          throw new ApiError(
            400,
            "No Vault folder configured for this team. Set a Vault path first.",
          );
        }
        pathToTest = folder.vaultPath;
      }

      // Validate the path format
      if (
        pathToTest.includes("..") ||
        pathToTest.startsWith("/") ||
        pathToTest.endsWith("/")
      ) {
        throw new ApiError(
          400,
          "Invalid Vault path. Path cannot contain '..', start with '/', or end with '/'",
        );
      }

      const result = await manager.checkFolderConnectivity(pathToTest);

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
    async (request, reply) => {
      const {
        params: { teamId },
        organizationId,
        user,
        headers,
      } = request;
      const manager = assertByosEnabled();

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user is team admin
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );

      await TeamModel.checkTeamAccess({ userId: user.id, teamId, isTeamAdmin });

      // Get the team's Vault folder
      const folder = await TeamVaultFolderModel.findByTeamId(teamId);
      if (!folder) {
        throw new ApiError(
          400,
          "No Vault folder configured for this team. Set a Vault path first.",
        );
      }

      const secrets = await manager.listSecretsInFolder(folder.vaultPath);

      return reply.send(secrets);
    },
  );

  /**
   * Get keys of a specific secret in team's Vault folder
   * Used to validate if a secret contains expected keys before selection
   */
  fastify.post(
    "/api/teams/:teamId/vault-folder/secrets/keys",
    {
      schema: {
        operationId: RouteId.GetTeamVaultSecretKeys,
        description:
          "Get the keys of a specific secret in a team's Vault folder",
        tags: ["Teams", "Vault"],
        params: z.object({
          teamId: z.string(),
        }),
        body: z.object({
          secretPath: z.string().min(1, "Secret path is required"),
        }),
        response: constructResponseSchema(VaultSecretKeysResponseSchema),
      },
    },
    async (request, reply) => {
      const {
        params: { teamId },
        body: { secretPath },
        organizationId,
        user,
        headers,
      } = request;
      const manager = assertByosEnabled();

      // Verify the team exists and belongs to the user's organization
      const team = await TeamModel.findById(teamId);
      if (!team || team.organizationId !== organizationId) {
        throw new ApiError(404, "Team not found");
      }

      // Check if user is team admin
      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        headers,
      );

      await TeamModel.checkTeamAccess({ userId: user.id, teamId, isTeamAdmin });

      // Get the team's Vault folder
      const folder = await TeamVaultFolderModel.findByTeamId(teamId);
      if (!folder) {
        throw new ApiError(
          400,
          "No Vault folder configured for this team. Set a Vault path first.",
        );
      }

      // Validate that the requested secret path is within the team's vault folder
      // Normalize paths by removing trailing slashes for comparison
      const normalizedVaultPath = folder.vaultPath.replace(/\/+$/, "");
      const normalizedSecretPath = secretPath.replace(/\/+$/, "");
      // Secret path must start with vault folder path followed by /
      // e.g., vaultPath "teams/alpha" should match "teams/alpha/secret" but not "teams/alphabeta"
      const isWithinFolder =
        normalizedSecretPath === normalizedVaultPath ||
        normalizedSecretPath.startsWith(`${normalizedVaultPath}/`);
      if (!isWithinFolder) {
        throw new ApiError(
          403,
          "Access denied. The requested secret is not within this team's Vault folder.",
        );
      }

      try {
        const secretData = await manager.getSecretFromPath(secretPath);
        const keys = Object.keys(secretData);

        return reply.send({ keys });
      } catch (error) {
        // Pass through ApiError from secretsmanager with proper status and message
        if (error instanceof ApiError) {
          throw error;
        }
        throw new ApiError(500, "Failed to retrieve secret from Vault");
      }
    },
  );
};

export default teamVaultFolderRoutes;
