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
  /** Emoji or image shown with the name; null = the plugin glyph. */
  icon: string | null;
  description: string;
  clientType: PluginClientType;
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
    icon: null,
    description: "",
    clientType: "claude-code",
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
    icon: plugin.icon ?? null,
    description: plugin.description,
    clientType: plugin.clientType,
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

/**
 * What still stops the draft from being saved, as a sentence for the person
 * filling it in; null once it can be saved.
 *
 * A file that exists but is empty installs nothing, so a manual plugin needs
 * content in at least one of its files. A Git plugin's files are the
 * repository's, and are not this form's to judge.
 */
export function pluginDraftGap(params: {
  draft: PluginDraft;
  isGithubPlugin: boolean;
}): string | null {
  const { draft, isGithubPlugin } = params;
  if (draft.displayName.trim().length === 0) return "Enter a display name.";
  if (draft.files.length === 0) return "Add at least one file.";
  if (isGithubPlugin) {
    // A public repository needs no credential.
    return draft.githubRepoUrl.trim().length > 0
      ? null
      : "Enter the repository URL.";
  }
  if (!draft.files.some((file) => file.content.trim().length > 0)) {
    return "Add content to at least one file.";
  }
  return null;
}

/** Shown, and sent back by the API, when an owner would hold a name twice. */
export const OWN_PLUGIN_NAME_TAKEN = "Name is already in use. Try another one.";

/**
 * Whether another plugin the viewer can see already carries this name for the
 * same client, and whose it is.
 *
 * `own`: the plugin's owner holds the name already. The API refuses that, so
 * the form does too. `other`: someone else's plugin holds it. That is allowed
 * (the server cannot refuse it without revealing plugins the viewer may not
 * see), but the two rows cannot be told apart in the list, so the form says so.
 */
export function pluginNameTwin(params: {
  displayName: string;
  clientType: string;
  /** Who the plugin belongs to: the viewer on create, its author on edit. */
  ownerId: string | null | undefined;
  /** The plugin being edited, left out of the comparison. */
  pluginId?: string;
  plugins: ReadonlyArray<{
    id: string;
    displayName: string;
    clientType: string;
    authorId?: string | null;
  }>;
}): "own" | "other" | null {
  const name = params.displayName.trim().toLowerCase();
  if (!name) return null;
  const twins = params.plugins.filter(
    (plugin) =>
      plugin.id !== params.pluginId &&
      plugin.clientType === params.clientType &&
      plugin.displayName.trim().toLowerCase() === name,
  );
  if (twins.length === 0) return null;
  return params.ownerId &&
    twins.some((plugin) => plugin.authorId === params.ownerId)
    ? "own"
    : "other";
}
