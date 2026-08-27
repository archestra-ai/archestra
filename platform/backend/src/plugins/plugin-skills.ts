import { userHasPermission } from "@/auth";
import { PluginModel, PluginTeamModel } from "@/models";
import {
  deriveSkillFileKind,
  parseSkillManifest,
  SKILL_MANIFEST_FILENAME,
  SkillParseError,
} from "@/skills/parser";
import type { PluginSkillDetail, PluginSkillListItem } from "@/types";

/**
 * Read-only projection of the SKILL.md trees embedded in plugins. Skills are
 * portable by design — a SKILL.md written for one coding client reads the
 * same in another — so a plugin shipped for a different client or platform
 * can still lend its skills. The projection derives everything from the
 * approved plugin bytes; nothing is stored, and plugin scope decides who
 * sees what (plugin:admin sees all).
 */
export async function listPluginSkills(params: {
  organizationId: string;
  userId: string;
}): Promise<PluginSkillListItem[]> {
  const { accessiblePluginIds } = await resolvePluginAccess(params);
  const candidates = await PluginModel.findSkillManifestCandidates({
    organizationId: params.organizationId,
    accessiblePluginIds,
  });
  const items: PluginSkillListItem[] = [];
  for (const { plugin, manifests, filePaths } of candidates) {
    const roots = manifests.map((manifest) => skillRootOf(manifest.path));
    for (const manifest of manifests) {
      if (manifest.encoding !== "utf8") continue;
      const parsed = tryParse(manifest.content);
      if (!parsed) continue;
      const root = skillRootOf(manifest.path);
      items.push({
        source: "plugin",
        pluginId: plugin.id,
        pluginName: plugin.displayName,
        pluginSlug: plugin.pluginSlug,
        pluginEnabled: plugin.enabled,
        scope: plugin.scope,
        clientType: plugin.clientType,
        supportedPlatforms: plugin.supportedPlatforms,
        skillPath: root,
        name: parsed.name,
        description: parsed.description,
        compatibility: parsed.compatibility,
        fileCount: resourcePathsOf(filePaths, manifest.path, root, roots)
          .length,
      });
    }
  }
  return items;
}

export async function getPluginSkill(params: {
  pluginId: string;
  skillPath: string;
  organizationId: string;
  userId: string;
}): Promise<PluginSkillDetail | null> {
  const { isAdmin, accessiblePluginIds } = await resolvePluginAccess(params);
  if (
    accessiblePluginIds !== undefined &&
    !accessiblePluginIds.includes(params.pluginId)
  ) {
    return null;
  }
  const plugin = await PluginModel.findById({
    id: params.pluginId,
    organizationId: params.organizationId,
  });
  if (!plugin) return null;

  const manifestPath =
    params.skillPath === ""
      ? SKILL_MANIFEST_FILENAME
      : `${params.skillPath}/${SKILL_MANIFEST_FILENAME}`;
  const manifest = plugin.files.find((file) => file.path === manifestPath);
  if (!manifest || manifest.encoding !== "utf8") return null;
  const parsed = tryParse(manifest.content);
  if (!parsed) return null;

  const root = params.skillPath;
  const roots = plugin.files
    .filter(
      (file) =>
        file.path === SKILL_MANIFEST_FILENAME ||
        file.path.endsWith(`/${SKILL_MANIFEST_FILENAME}`),
    )
    .map((file) => skillRootOf(file.path));
  const filePaths = plugin.files.map((file) => file.path);
  const resources = resourcePathsOf(filePaths, manifestPath, root, roots);
  const filesByPath = new Map(plugin.files.map((file) => [file.path, file]));

  return {
    source: "plugin",
    pluginId: plugin.id,
    pluginName: plugin.displayName,
    pluginSlug: plugin.pluginSlug,
    pluginEnabled: plugin.enabled,
    scope: plugin.scope,
    clientType: plugin.clientType,
    supportedPlatforms: plugin.supportedPlatforms,
    skillPath: root,
    name: parsed.name,
    description: parsed.description,
    compatibility: parsed.compatibility,
    fileCount: resources.length,
    manifest: manifest.content,
    content: parsed.content,
    allowedTools: parsed.allowedTools,
    resourcesRestricted: !isAdmin && resources.length > 0,
    files: isAdmin
      ? resources.flatMap((path) => {
          const file = filesByPath.get(path);
          if (!file) return [];
          const relativePath = root === "" ? path : path.slice(root.length + 1);
          return [
            {
              path: relativePath,
              content: file.content,
              encoding: file.encoding,
              kind: deriveSkillFileKind(relativePath),
            },
          ];
        })
      : [],
  };
}

// ===== Internal helpers =====

/** undefined = plugin admin (all plugins); otherwise the visible id set. */
async function resolvePluginAccess(params: {
  organizationId: string;
  userId: string;
}): Promise<{ isAdmin: boolean; accessiblePluginIds: string[] | undefined }> {
  const isAdmin = await userHasPermission(
    params.userId,
    params.organizationId,
    "plugin",
    "admin",
  );
  return {
    isAdmin,
    accessiblePluginIds: isAdmin
      ? undefined
      : await PluginTeamModel.getUserAccessiblePluginIds({
          organizationId: params.organizationId,
          userId: params.userId,
        }),
  };
}

function tryParse(content: string) {
  try {
    return parseSkillManifest(content);
  } catch (error) {
    if (error instanceof SkillParseError) return null;
    throw error;
  }
}

function skillRootOf(manifestPath: string): string {
  const index = manifestPath.lastIndexOf("/");
  return index === -1 ? "" : manifestPath.slice(0, index);
}

/**
 * File paths belonging to one skill tree: everything under its root except
 * the manifest itself and anything a deeper skill root owns.
 */
function resourcePathsOf(
  filePaths: string[],
  manifestPath: string,
  root: string,
  allRoots: string[],
): string[] {
  const deeperRoots = allRoots.filter(
    (candidate) =>
      candidate !== root && (root === "" || candidate.startsWith(`${root}/`)),
  );
  return filePaths.filter((path) => {
    if (path === manifestPath) return false;
    if (root !== "" && !path.startsWith(`${root}/`)) return false;
    return !deeperRoots.some(
      (deeper) => deeper !== "" && path.startsWith(`${deeper}/`),
    );
  });
}
