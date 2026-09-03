import type { ResourceVisibilityScope } from "@archestra/shared";
import type { ProfileLabel } from "@/components/agent-labels";
import type { GithubAuthMethod } from "@/components/github-auth-config-fields";
import type { PluginDetail } from "@/lib/plugins/plugin.query";
import type {
  PluginClientType,
  PluginFileDraft,
} from "./plugin-content-fields";
import type { PluginPlatform } from "./plugin-platforms";

/**
 * A plugin as it sits in the form before a write: what it is and what it
 * installs, where its files come from when they come from GitHub, and who can
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
  scope: ResourceVisibilityScope;
  teamIds: string[];
  /** People the plugin is shared with by name; only meaningful with `personal`. */
  userIds: string[];
  labels: ProfileLabel[];
  githubRepoUrl: string;
  githubSyncRef: string;
  githubSyncInterval: "15m" | "1h" | "1d" | null;
  githubAuthMethod: GithubAuthMethod;
  githubAppConfigId: string;
  /** Write-only: blank keeps whatever credential the plugin already uses. */
  githubToken: string;
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
    scope: "personal",
    teamIds: [],
    userIds: [],
    labels: [],
    githubRepoUrl: "",
    githubSyncRef: "",
    githubSyncInterval: null,
    githubAuthMethod: "pat",
    githubAppConfigId: "",
    githubToken: "",
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
    scope: plugin.scope,
    teamIds: plugin.teams.map((team) => team.id),
    userIds: plugin.users.map((member) => member.id),
    labels: plugin.labels ?? [],
    githubRepoUrl: plugin.sourceRepo ?? "",
    githubSyncRef: plugin.githubSyncRef ?? plugin.sourceRef ?? "",
    githubSyncInterval: plugin.githubSyncInterval,
    githubAuthMethod: plugin.githubAppConfigId ? "github_app" : "pat",
    githubAppConfigId: plugin.githubAppConfigId ?? "",
    githubToken: "",
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
  /** The credential the plugin was loaded with, if any. */
  seedAuthMethod?: GithubAuthMethod;
}): boolean {
  const { draft, isGithubPlugin, seedAuthMethod } = params;
  if (draft.displayName.trim().length === 0 || draft.files.length === 0) {
    return false;
  }
  if (!isGithubPlugin) return true;
  const authenticationComplete =
    draft.githubAuthMethod === "github_app"
      ? draft.githubAppConfigId.length > 0
      : // A plugin that already authenticates with a saved token keeps it when
        // the field is left blank; one switching away from a GitHub App has to
        // supply the token it is switching to.
        seedAuthMethod !== "github_app" || draft.githubToken.trim().length > 0;
  return draft.githubRepoUrl.trim().length > 0 && authenticationComplete;
}
