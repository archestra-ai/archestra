import GithubPatModel from "@/models/github-pat";
import PluginModel from "@/models/plugin";
import SkillModel from "@/models/skill";
import { secretManager } from "@/secrets-manager";
import {
  ApiError,
  type CreateGithubPatRequest,
  type GithubPat,
  type PublicGithubPat,
  type UpdateGithubPatRequest,
} from "@/types";
import { isForeignKeyConstraintError } from "@/utils/db";

export async function listGithubPats(
  organizationId: string,
): Promise<PublicGithubPat[]> {
  const pats = await GithubPatModel.findByOrganization(organizationId);
  return pats.map(toPublicGithubPat);
}

export async function createGithubPat(params: {
  organizationId: string;
  data: CreateGithubPatRequest;
}): Promise<PublicGithubPat> {
  const { organizationId, data } = params;
  const secret = await secretManager().createSecret(
    { apiToken: data.token },
    `github-pat-${data.name}`,
  );

  const pat = await GithubPatModel.create({
    organizationId,
    name: data.name,
    secretId: secret.id,
  });

  return toPublicGithubPat(pat);
}

export async function updateGithubPat(params: {
  id: string;
  organizationId: string;
  data: UpdateGithubPatRequest;
}): Promise<PublicGithubPat> {
  const { id, organizationId, data } = params;
  const existing = await requireGithubPat({ id, organizationId });

  let secretId = existing.secretId;
  if (data.token) {
    if (existing.secretId) {
      await secretManager().updateSecret(existing.secretId, {
        apiToken: data.token,
      });
    } else {
      const secret = await secretManager().createSecret(
        { apiToken: data.token },
        `github-pat-${data.name ?? existing.name}`,
      );
      secretId = secret.id;
    }
  }

  const updated = await GithubPatModel.update(id, {
    name: data.name,
    secretId,
  });
  if (!updated) {
    throw new ApiError(404, "GitHub token not found");
  }

  return toPublicGithubPat(updated);
}

export async function deleteGithubPat(params: {
  id: string;
  organizationId: string;
}): Promise<void> {
  const existing = await requireGithubPat(params);

  // synced skills authenticate their scheduled pulls with this token; deleting
  // it out from under them would break every next sync
  const referencingSkills = await SkillModel.countSyncedReferencingGithubPat(
    existing.id,
  );
  if (referencingSkills > 0) {
    throw new ApiError(
      409,
      `GitHub token is in use by ${referencingSkills} synced skill(s) and cannot be deleted. Disconnect those skills from GitHub first.`,
    );
  }
  const referencingPlugins = await PluginModel.countSyncedReferencingGithubPat(
    existing.id,
  );
  if (referencingPlugins > 0) {
    throw new ApiError(
      409,
      `GitHub token is in use by ${referencingPlugins} GitHub-linked plugin(s) and cannot be deleted. Remove or reconnect those plugins first.`,
    );
  }

  try {
    await GithubPatModel.delete(existing.id);
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      throw new ApiError(
        409,
        "GitHub token became referenced by a synced resource; disconnect it and retry",
      );
    }
    throw error;
  }
  if (existing.secretId) {
    try {
      await secretManager().deleteSecret(existing.secretId);
    } catch (error) {
      await GithubPatModel.restore(existing);
      throw error;
    }
  }
}

// ===== Internal helpers =====

async function requireGithubPat(params: {
  id: string;
  organizationId: string;
}): Promise<GithubPat> {
  const pat = await GithubPatModel.findByIdForOrganization(params);
  if (!pat) {
    throw new ApiError(404, "GitHub token not found");
  }
  return pat;
}

function toPublicGithubPat(pat: GithubPat): PublicGithubPat {
  const { secretId: _secretId, ...rest } = pat;
  return rest;
}
