import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { GITHUB_COM_API_URL } from "@/types";

/**
 * The API root of the GitHub Apps among these credentials, for helpers that
 * read GITHUB_API_URL; none for GitHub.com, their default, or when the Apps
 * disagree.
 */
export async function boundGithubApiUrl(params: {
  organizationId: string;
  credentialKeys: string[];
}): Promise<string | null> {
  const definitions = await RuntimeCredentialDefinitionModel.findByKeys({
    organizationId: params.organizationId,
    keys: params.credentialKeys,
  });
  const roots = new Set(
    [...definitions.values()].flatMap(({ kind, githubUrl }) =>
      kind === "github_app"
        ? [(githubUrl ?? GITHUB_COM_API_URL).replace(/\/+$/, "")]
        : [],
    ),
  );
  const [root] = roots;
  return roots.size === 1 && root !== GITHUB_COM_API_URL ? root : null;
}
