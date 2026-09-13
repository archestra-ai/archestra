import type { GithubPat, InsertGithubPat, UpdateGithubPat } from "@/types";
import {
  createSharedCredential,
  deleteSharedCredential,
  listSharedCredentials,
  updateSharedCredential,
} from "./_shared/credential-store";

/** Typed GitHub access to the shared credential store. */
export default class GithubPatModel {
  static async findByOrganization(
    organizationId: string,
  ): Promise<GithubPat[]> {
    const rows = await listSharedCredentials(organizationId, "secret");
    return rows.map(({ definition, secretId }) => ({
      id: definition.id,
      organizationId: definition.organizationId,
      name: definition.name,
      secretId,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
    }));
  }
  static async findByIdForOrganization(params: {
    id: string;
    organizationId: string;
  }): Promise<GithubPat | null> {
    return (
      (await GithubPatModel.findByOrganization(params.organizationId)).find(
        (row) => row.id === params.id,
      ) ?? null
    );
  }
  static async create(data: InsertGithubPat): Promise<GithubPat> {
    const definition = await createSharedCredential({
      ...data,
      kind: "secret",
    });
    return {
      id: definition.id,
      organizationId: definition.organizationId,
      name: definition.name,
      secretId: data.secretId ?? null,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
    };
  }
  static async update(
    id: string,
    data: Partial<UpdateGithubPat>,
  ): Promise<GithubPat | null> {
    const definition = await updateSharedCredential(id, data);
    return definition
      ? GithubPatModel.findByIdForOrganization({
          id,
          organizationId: definition.organizationId,
        })
      : null;
  }
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const record = await GithubPatModel.findByIdForOrganization({
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
