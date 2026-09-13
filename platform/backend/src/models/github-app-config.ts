import type {
  GithubAppConfig,
  InsertGithubAppConfig,
  UpdateGithubAppConfig,
} from "@/types";
import {
  createSharedCredential,
  deleteSharedCredential,
  listSharedCredentials,
  updateSharedCredential,
} from "./_shared/credential-store";

/** Typed GitHub access to the shared credential store. */
export default class GithubAppConfigModel {
  static async findByOrganization(
    organizationId: string,
  ): Promise<GithubAppConfig[]> {
    const rows = await listSharedCredentials(organizationId, "github_app");
    return rows.map(({ definition, secretId }) => ({
      id: definition.id,
      organizationId: definition.organizationId,
      name: definition.name,
      secretId,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
      githubUrl: definition.githubUrl ?? "https://api.github.com",
      appId: definition.appId ?? "",
      installationId: definition.installationId ?? "",
    }));
  }
  static async findByIdForOrganization(params: {
    id: string;
    organizationId: string;
  }): Promise<GithubAppConfig | null> {
    return (
      (
        await GithubAppConfigModel.findByOrganization(params.organizationId)
      ).find((row) => row.id === params.id) ?? null
    );
  }
  static async create(data: InsertGithubAppConfig): Promise<GithubAppConfig> {
    const definition = await createSharedCredential({
      ...data,
      kind: "github_app",
    });
    return {
      id: definition.id,
      organizationId: definition.organizationId,
      name: definition.name,
      secretId: data.secretId ?? null,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
      githubUrl: definition.githubUrl ?? "https://api.github.com",
      appId: definition.appId ?? "",
      installationId: definition.installationId ?? "",
    };
  }
  static async update(
    id: string,
    data: Partial<UpdateGithubAppConfig>,
  ): Promise<GithubAppConfig | null> {
    const definition = await updateSharedCredential(id, data);
    return definition
      ? GithubAppConfigModel.findByIdForOrganization({
          id,
          organizationId: definition.organizationId,
        })
      : null;
  }
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const record = await GithubAppConfigModel.findByIdForOrganization({
      id,
      organizationId,
    });
    if (!record) return null;
    const { secretId: _secretId, ...snapshot } = record;
    return snapshot;
  }
  static async delete(id: string): Promise<boolean> {
    return deleteSharedCredential(id);
  }
}
