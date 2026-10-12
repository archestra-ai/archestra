import type { ProfileLabel } from "@/components/agent-labels";
import type { InitialPermissionGrant } from "@/components/initial-resource-permissions";
import type { PluginDetail } from "@/lib/plugins/plugin.query";
import type {
  PluginClientType,
  PluginFileDraft,
} from "./plugin-content-fields";
import type { PluginPlatform } from "./plugin-platforms";

/**
 * A plugin as it sits in the form before a write: what it is and what it
 * installs, where its files come from when they come from Git, and who can
 * discover it. The create page and the plugin's own page fill the same draft
 * with the same form, so the shape is owned here rather than by either of them.
 */
export interface PluginDraft {
  displayName: string;
  description: string;
  clientType: PluginClientType;
  enabled: boolean;
  supportedPlatforms: PluginPlatform[];
  files: PluginFileDraft[];
  initialGrants: InitialPermissionGrant[];
  labels: ProfileLabel[];
  githubRepoUrl: string;
  githubSyncRef: string;
  githubSyncInterval: "15m" | "1h" | "1d" | null;
  /**
   * How the source is read: "" for a public repository, otherwise
   * `github_app:<id>`, `gitlab_token:<id>`, or `pat:<id>` (a legacy saved
   * GitHub token, kept working but no longer offered).
   */
  gitCredential: string;
}

/** The credential columns a plugin's Git source saves. */
export function pluginGitAuthentication(gitCredential: string): {
  githubAppConfigId: string | null;
  githubPatId: string | null;
  gitlabTokenId: string | null;
} {
  const [kind, id = ""] = gitCredential.split(":");
  return {
    githubAppConfigId: kind === "github_app" ? id : null,
    githubPatId: kind === "pat" ? id : null,
    gitlabTokenId: kind === "gitlab_token" ? id : null,
  };
}

/** A blank plugin, as the create page starts it. */
export function blankPluginDraft(): PluginDraft {
  return {
    displayName: "",
    description: "",
    clientType: "claude-code",
    enabled: true,
    supportedPlatforms: ["posix", "windows"],
    files: [
      {
        path: "hooks/hooks.json",
        content: "",
        encoding: "utf8",
        mode: "100644",
      },
    ],
    initialGrants: [],
    labels: [],
    githubRepoUrl: "",
    githubSyncRef: "",
    githubSyncInterval: null,
    gitCredential: "",
  };
}

export function pluginDraftFromPlugin(plugin: PluginDetail): PluginDraft {
  return {
    displayName: plugin.displayName,
    description: plugin.description,
    clientType: plugin.clientType,
    enabled: plugin.enabled,
    supportedPlatforms: plugin.supportedPlatforms,
    files: plugin.files.map(({ path, content, encoding, mode }) => ({
      path,
      content,
      encoding,
      mode,
    })),
    initialGrants: [],
    labels: plugin.labels ?? [],
    githubRepoUrl: plugin.sourceRepo ?? "",
    githubSyncRef: plugin.githubSyncRef ?? plugin.sourceRef ?? "",
    githubSyncInterval: plugin.githubSyncInterval,
    gitCredential: plugin.githubAppConfigId
      ? `github_app:${plugin.githubAppConfigId}`
      : plugin.gitlabTokenId
        ? `gitlab_token:${plugin.gitlabTokenId}`
        : plugin.githubPatId
          ? `pat:${plugin.githubPatId}`
          : "",
  };
}

/** Whether the draft differs from the seed it was built from. */
export function isPluginDraftDirty(draft: PluginDraft, seed: PluginDraft) {
  return JSON.stringify(draft) !== JSON.stringify(seed);
}

/** A plugin can be saved once it is named and installs something. */
export function isPluginDraftComplete(params: {
  draft: PluginDraft;
  isGithubPlugin: boolean;
}): boolean {
  const { draft, isGithubPlugin } = params;
  if (draft.displayName.trim().length === 0 || draft.files.length === 0) {
    return false;
  }
  // A public repository needs no credential.
  return !isGithubPlugin || draft.githubRepoUrl.trim().length > 0;
}
